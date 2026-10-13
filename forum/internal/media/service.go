// Package media 是图片域：上传（头像 / 帖子配图 / 收款码）、内容寻址分发、引用计数。
//
// 站点只有**一条**图片读路径 /img/{hash}，它查 images 一张表；引用行（topic_images /
// payment_channels / users 的三根头像列）只是引用。老站「收款码 404」的根因就是读路径有第二份实现。
// 依据：完全重构/后端设计/d5-content.md、交接单 d5-content-交接.md。
package media

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/db"
	"forum/internal/platform/idgen"
	"forum/internal/platform/image"
	"forum/internal/platform/image/imgsize"
)

// 可见性三值。**跟已落地的迁移**（images.visibility smallint CHECK IN (0,1,2)），
// 不是 d5 §2.1 的 text 三值——改列类型要动别人的迁移，已登记在回报里。
const (
	VisibilityPublic  = 0
	VisibilityLogin   = 1
	VisibilityPrivate = 2
)

// 每帖配图上限 = ck_topic_images_sort 的上界 + 1。
const maxTopicImages = 9

// 每用户收款码上限（d5 §3.2）。
const maxPaymentChannels = 5

// 默认收款码标签。
const defaultChannelLabel = "收款码"

// Service 是媒体域的全部业务逻辑。actor 由 handler 显式传入（拍板 §5.3），不从 context 取。
type Service struct {
	cfg   Config
	db    *ent.Client
	store image.Store
	clk   clock.Clock
	log   *slog.Logger
}

// Config 是本模块的上限与开关（config.Image 的子集）。
type Config struct {
	AvatarMax    int64
	PostMax      int64
	PaymentMax   int64
	ServeLocally bool // true = Go 直接发字节；false = X-Accel-Redirect 交给 nginx
}

// NewService 的签名就是接线契约。
func NewService(cfg Config, db *ent.Client, store image.Store, clk clock.Clock, log *slog.Logger) *Service {
	if cfg.AvatarMax <= 0 {
		cfg.AvatarMax = 64 << 10
	}
	if cfg.PostMax <= 0 {
		cfg.PostMax = 2 << 20
	}
	if cfg.PaymentMax <= 0 {
		cfg.PaymentMax = 512 << 10
	}
	return &Service{cfg: cfg, db: db, store: store, clk: clk, log: log}
}

// PutImage 把字节写进内容寻址存储并返回 (hash, size, mime, 宽, 高)。
// 它是**唯一**的落盘入口：三个上传端点都先在这里落盘，再开事务写引用行
// （拍板 §5.4：事务里禁止写文件）。事务回滚留下的孤儿由 image:gc 兜。
func (s *Service) PutImage(ctx context.Context, actor *authz.Actor, body []byte, maxBytes int64, visibility int) (image.Hash, int64, string, int, int, error) {
	if err := requireActive(actor); err != nil {
		return "", 0, "", 0, 0, err
	}
	if int64(len(body)) > maxBytes {
		return "", 0, "", 0, 0, ErrTooLarge
	}
	mime, w, h, err := sniff(body, maxBytes, int64(len(body)))
	if err != nil {
		return "", 0, "", 0, 0, err
	}
	hsh, size, err := s.store.Put(ctx, bytes.NewReader(body), maxBytes)
	if err != nil {
		return "", 0, "", 0, 0, mapStoreErr(err)
	}
	owner := actor.UserID
	if err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		return incRefTx(ctx, tx, string(hsh), size, mime, w, h, visibility, &owner)
	}); err != nil {
		return "", 0, "", 0, 0, err
	}
	return hsh, size, mime, w, h, nil
}

// UploadAvatar 换头像：落盘 → 事务（旧图 −1 / 新图 +1 / 写列）。
// 重复上传同一张图（hash 没变）不重写引用，返回 Created=false，handler 用 200。
func (s *Service) UploadAvatar(ctx context.Context, actor *authz.Actor, in UploadAvatarInput) (*AvatarResult, error) {
	if err := requireActive(actor); err != nil {
		return nil, err
	}
	mime, w, h, err := sniff(in.Body, s.cfg.AvatarMax, int64(len(in.Body)))
	if err != nil {
		return nil, err
	}
	if int64(len(in.Body)) > s.cfg.AvatarMax {
		return nil, ErrTooLarge
	}
	hsh, size, err := s.store.Put(ctx, bytes.NewReader(in.Body), s.cfg.AvatarMax)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	created := false
	owner := actor.UserID
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		old, err := readAvatarTx(ctx, tx, actor.UserID)
		if err != nil {
			return err
		}
		if old == string(hsh) {
			return nil // 内容没变：不动引用计数，也不动列
		}
		created = true
		if err := incRefTx(ctx, tx, string(hsh), size, mime, w, h, VisibilityPublic, &owner); err != nil {
			return err
		}
		if old != "" {
			if err := decRefTx(ctx, tx, old); err != nil {
				return err
			}
		}
		return setAvatarTx(ctx, tx, actor.UserID, string(hsh))
	})
	if err != nil {
		return nil, err
	}
	return &AvatarResult{Hash: string(hsh), URL: urlOf(string(hsh)), Width: w, Height: h, Size: size, Created: created}, nil
}

// ClearAvatar 清掉头像两列并给旧图 −1。没有头像时是 no-op（幂等）。
func (s *Service) ClearAvatar(ctx context.Context, actor *authz.Actor) error {
	if err := requireActive(actor); err != nil {
		return err
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		old, err := readAvatarTx(ctx, tx, actor.UserID)
		if err != nil {
			return err
		}
		if old == "" {
			return nil
		}
		if err := decRefTx(ctx, tx, old); err != nil {
			return err
		}
		return clearAvatarTx(ctx, tx, actor.UserID)
	})
}

// AttachTopicImage：作者本人或持 topic.delete.any；主题必须 normal；每帖 ≤9。
// 数量闸门与插入**同一事务**，靠 topics 行锁串行化（两个并发请求各读 count=8 会双双插入）。
func (s *Service) AttachTopicImage(ctx context.Context, actor *authz.Actor, in AttachTopicImageInput) (*AttachedImage, error) {
	if err := requireActive(actor); err != nil {
		return nil, err
	}
	if !actor.IsSuper && !actor.Perms.Has(authz.PermTopicCreate) {
		return nil, apperr.ErrForbidden
	}
	if _, _, _, err := sniff(in.Body, s.cfg.PostMax, int64(len(in.Body))); err != nil {
		return nil, err
	}
	hsh, size, mime, w, h, err := s.PutImage(ctx, actor, in.Body, s.cfg.PostMax, VisibilityPublic)
	if err != nil {
		return nil, err
	}
	var sort int
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		topicID, authorID, visibility, err := lockTopic(ctx, tx, in.TopicPublicID)
		if err != nil {
			return err
		}
		if topicID == 0 || visibility != "normal" {
			return ErrNotFound
		}
		if authorID != actor.UserID && !actor.IsSuper && !actor.Perms.Has(authz.PermTopicDeleteAny) {
			return apperr.ErrForbidden
		}
		n, err := countTopicImages(ctx, tx, topicID)
		if err != nil {
			return err
		}
		if n >= maxTopicImages {
			return ErrLimitReached.WithMsg(fmt.Sprintf("每帖最多 %d 张图片", maxTopicImages))
		}
		postID, err := firstPost(ctx, tx, topicID)
		if err != nil {
			return err
		}
		if postID == 0 {
			return ErrNotFound.WithMsg("主题还没有 1 楼，先发正文再配图")
		}
		sort, err = nextSort(ctx, tx, topicID, postID)
		if err != nil {
			return err
		}
		owner := actor.UserID
		if err := incRefTx(ctx, tx, string(hsh), size, mime, w, h, VisibilityPublic, &owner); err != nil {
			return err
		}
		return insertTopicImage(ctx, tx, topicID, postID, string(hsh), sort)
	})
	if err != nil {
		return nil, err
	}
	return &AttachedImage{Hash: string(hsh), URL: urlOf(string(hsh)), Width: w, Height: h, Sort: sort}, nil
}

// DetachTopicImage：归属判定在 DELETE 的 WHERE 里（0 行 = 404），不泄漏「这个 hash 存在过」。
func (s *Service) DetachTopicImage(ctx context.Context, actor *authz.Actor, in DetachTopicImageInput) error {
	if err := requireActive(actor); err != nil {
		return err
	}
	if !isHash(in.Hash) {
		return ErrBadType.WithMsg("图片地址不正确")
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		topicID, authorID, _, err := lockTopic(ctx, tx, in.TopicPublicID)
		if err != nil {
			return err
		}
		if topicID == 0 {
			return ErrNotFound
		}
		if authorID != actor.UserID && !actor.IsSuper && !actor.Perms.Has(authz.PermTopicDeleteAny) {
			return ErrNotFound
		}
		ok, err := deleteTopicImage(ctx, tx, topicID, in.Hash)
		if err != nil {
			return err
		}
		if !ok {
			return ErrNotFound
		}
		return decRefTx(ctx, tx, in.Hash)
	})
}

// AddPaymentChannel：每用户 ≤5，行锁串行化；visibility 固定 private（d5 §3.2）。
func (s *Service) AddPaymentChannel(ctx context.Context, actor *authz.Actor, in AddPaymentChannelInput) (*PaymentChannel, error) {
	if err := requireActive(actor); err != nil {
		return nil, err
	}
	label := sanitizeLabel(in.Label)
	hsh, size, mime, w, h, err := s.PutImage(ctx, actor, in.Body, s.cfg.PaymentMax, VisibilityPrivate)
	if err != nil {
		return nil, err
	}
	var publicID string
	var sort int
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		if err := lockUser(ctx, tx, actor.UserID); err != nil {
			return err
		}
		n, err := countChannels(ctx, tx, actor.UserID)
		if err != nil {
			return err
		}
		if n >= maxPaymentChannels {
			return ErrLimitReached.WithMsg(fmt.Sprintf("最多只能添加 %d 个收款码", maxPaymentChannels))
		}
		owner := actor.UserID
		if err := incRefTx(ctx, tx, string(hsh), size, mime, w, h, VisibilityPrivate, &owner); err != nil {
			return err
		}
		newID, err := idgen.NewPublicID()
		if err != nil {
			return err
		}
		id, err := insertChannel(ctx, tx, actor.UserID, newID.String(), label, string(hsh))
		if err != nil {
			return err
		}
		publicID, sort, err = channelPublicID(ctx, tx, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &PaymentChannel{ID: publicID, Label: label, Image: urlOf(string(hsh)), Sort: sort}, nil
}

// ListPaymentChannels 列出某个用户的收款码。userPublicID 为空时就是自己。
// 图片 URL 与「这张图对访客可不可见」是两件事：判定在 /img/{hash} 那一处（d5 §3.3 的已知取舍）。
func (s *Service) ListPaymentChannels(ctx context.Context, actor *authz.Actor, userPublicID string) ([]PaymentChannel, error) {
	userID := int64(0)
	if userPublicID == "" || (actor != nil && userPublicID == actor.PublicID) {
		if err := requireActor(actor); err != nil {
			return nil, err
		}
		userID = actor.UserID
	} else {
		id, err := userIDByPublicID(ctx, s.db, userPublicID)
		if err != nil {
			return nil, err
		}
		if id == 0 {
			return nil, apperr.ErrNotFound
		}
		userID = id
	}
	return listChannels(ctx, s.db, userID)
}

// DeletePaymentChannel：归属判定在 WHERE 里（0 行 = 404）。
func (s *Service) DeletePaymentChannel(ctx context.Context, actor *authz.Actor, channelPublicID string) error {
	if err := requireActive(actor); err != nil {
		return err
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		hash, err := deleteChannel(ctx, tx, actor.UserID, channelPublicID)
		if err != nil {
			return err
		}
		if hash == "" {
			return ErrNotFound
		}
		return decRefTx(ctx, tx, hash)
	})
}

// FetchImage 是 GET /img/{hash} 的落点：**唯一**的图片读路径。
// 权限不足返回占位图（200 + no-store），绝不 404——<img> 只会把它画成裂图。
func (s *Service) FetchImage(ctx context.Context, actor *authz.Actor, hash string) (*ImageResponse, error) {
	if !isHash(hash) {
		return nil, ErrBadType.WithMsg("图片地址不正确")
	}
	meta, err := imageMeta(ctx, s.db, hash)
	if err != nil {
		return nil, err
	}
	if meta == nil {
		return nil, ErrNotFound
	}
	rel := hash[:2] + "/" + hash[2:4] + "/" + hash
	if !canView(actor, meta) {
		return &ImageResponse{Mime: "image/png", Size: int64(len(placeholderPNG)), Placeholder: placeholderPNG}, nil
	}
	resp := &ImageResponse{Mime: meta.Mime, Size: meta.Size, Path: rel, Cache: true}
	if s.cfg.ServeLocally {
		rc, err := s.store.Open(ctx, image.Hash(hash))
		if errors.Is(err, image.ErrNotFound) {
			// 行在文件丢：运维事故，不是用户错
			s.log.Error("图片行在但文件不在", "hash", hash)
			return nil, apperr.ErrInternal
		}
		if err != nil {
			return nil, err
		}
		resp.Body = rc
	}
	return resp, nil
}

// IncRefTx / DecRefTx 是给别的域的唯一两个方法（d5 §4.3）：
// 引用行在谁的表里，谁负责在同一事务里调它们。±1 不许自己写 SQL。
func (s *Service) IncRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error {
	return decOrInc(ctx, tx, string(h), true)
}

func (s *Service) DecRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error {
	return decOrInc(ctx, tx, string(h), false)
}

// decOrInc 让两个导出方法共用一条路径：现有的引用行不动，只动计数。
func decOrInc(ctx context.Context, tx *ent.Tx, hash string, inc bool) error {
	if inc {
		_, err := tx.ExecContext(ctx, `
UPDATE images SET refcount = refcount + 1, updated_at = now() WHERE hash = $1`, hash)
		if err != nil {
			return fmt.Errorf("media: incref %s: %w", hash, err)
		}
		return nil
	}
	return decRefTx(ctx, tx, hash)
}

// GCImages 是 image:gc 任务的处理函数：把「归零满一小时、且不在默认头像池里」的行与文件删掉。
// 幂等：任何一步失败下一轮重试，行只在文件删掉（或本来就没有）之后才删。
func (s *Service) GCImages(ctx context.Context, _ []byte) error {
	candidates, err := gcCandidates(ctx, s.db, 500)
	if err != nil {
		return err
	}
	for _, hash := range candidates {
		if err := ctx.Err(); err != nil {
			return err
		}
		switch err := s.store.Delete(ctx, image.Hash(hash)); {
		case err == nil:
		case errors.Is(err, image.ErrNotFound):
		default:
			s.log.Warn("image:gc 删文件失败，下轮重试", "hash", hash, "err", err.Error())
			continue
		}
		if err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
			return deleteImageRow(ctx, tx, hash)
		}); err != nil {
			return err
		}
	}
	return nil
}

// ── 内部工具 ────────────────────────────────────────────────────

// sniff 判类型与尺寸。判的是**字节**，不是 Content-Type、不是扩展名（d5 §1.3）。
func sniff(body []byte, maxBytes, declared int64) (string, int, int, error) {
	if declared > maxBytes {
		return "", 0, 0, ErrTooLarge
	}
	head := body
	if len(head) > 512 {
		head = head[:512]
	}
	mime, ok := imgsize.Sniff(head)
	if !ok {
		return "", 0, 0, ErrBadType.WithMsg(imgsize.UnsupportedMessage(head, false))
	}
	w, h, err := imgsize.Size(mime, head, tailOf(body), int64(len(body)))
	if err != nil {
		return "", 0, 0, ErrBadType.WithMsg(err.Error())
	}
	return mime, w, h, nil
}

// tailOf 给 imgsize 一个按需读回调（JPEG 的 SOF 可能在几百 KB 的 EXIF 之后）。
// 上传时整块已经在内存里（上限 2MB，d5 §3.1 的设计边界），所以这里不必再读盘。
func tailOf(body []byte) func(int64, int) ([]byte, error) {
	return func(off int64, n int) ([]byte, error) {
		if off < 0 || off >= int64(len(body)) {
			return nil, io.EOF
		}
		end := off + int64(n)
		if end > int64(len(body)) {
			end = int64(len(body))
		}
		return body[off:end], nil
	}
}

func mapStoreErr(err error) error {
	switch {
	case errors.Is(err, image.ErrTooLarge):
		return ErrTooLarge
	case errors.Is(err, image.ErrBadType):
		return ErrBadType
	case errors.Is(err, image.ErrDiskFull):
		return ErrDiskFull
	case errors.Is(err, image.ErrNotFound):
		return ErrNotFound
	}
	return err
}

// canView 是**唯一**一份可见性判定（d5 §3.4）。
func canView(actor *authz.Actor, img *imageRow) bool {
	switch img.Visibility {
	case VisibilityPublic:
		return true
	case VisibilityLogin:
		return actor != nil && actor.UserID != 0
	case VisibilityPrivate:
		if actor == nil || actor.UserID == 0 {
			return false
		}
		if actor.IsSuper || actor.Perms.Has(authz.PermRewardVerify) {
			return true
		}
		return img.OwnerID != nil && *img.OwnerID == actor.UserID
	}
	return false
}

// sanitizeLabel 去控制字符并截到 32 字符（payment_channels.label varchar(32)）。
func sanitizeLabel(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7F {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if s == "" {
		return defaultChannelLabel
	}
	if r := []rune(s); len(r) > 32 {
		return string(r[:32])
	}
	return s
}

func isHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
