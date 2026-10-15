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

// PutImage 把字节写进内容寻址存储并返回它的事实（hash / 字节数 / mime / 宽高）。
//
// 它**不写库、不计引用**：写引用行是引用行的写者在自己事务里的事（d5 §2.2 的时机表）。
// 落盘必须在事务外（拍板 §5.4）；事务回滚留下的孤儿文件由 image:gc 兜底。
func (s *Service) PutImage(ctx context.Context, actor *authz.Actor, body []byte, maxBytes int64) (image.Hash, int64, string, int, int, error) {
	if err := requireActive(actor); err != nil {
		return "", 0, "", 0, 0, err
	}
	mime, w, h, err := sniff(body, maxBytes, int64(len(body)))
	if err != nil {
		return "", 0, "", 0, 0, err
	}
	hsh, size, err := s.store.Put(ctx, bytes.NewReader(body), maxBytes)
	if err != nil {
		return "", 0, "", 0, 0, mapStoreErr(err)
	}
	return hsh, size, mime, w, h, nil
}

// UploadAvatar 换头像：落盘 → 事务（旧图 −1 / 新图 +1 / 写列）。
// 重复上传同一张图（hash 没变）不重写引用，返回 Created=false，handler 用 200。
func (s *Service) UploadAvatar(ctx context.Context, actor *authz.Actor, in UploadAvatarInput) (*AvatarResult, error) {
	if err := requireActive(actor); err != nil {
		return nil, err
	}
	hsh, size, mime, w, h, err := s.PutImage(ctx, actor, in.Body, s.cfg.AvatarMax)
	if err != nil {
		return nil, err
	}
	created := false
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		old, err := readUserImageTx(ctx, tx, "avatar_hash", actor.UserID)
		if err != nil {
			return err
		}
		if old == string(hsh) {
			return nil // 内容没变：不动引用计数，也不动列
		}
		created = true
		owner := actor.UserID
		if _, err := refTx(ctx, tx, string(hsh), size, mime, w, h, VisibilityPublic, &owner); err != nil {
			return err
		}
		if old != "" {
			if err := decRefTx(ctx, tx, old); err != nil {
				return err
			}
		}
		newHash := string(hsh)
		return setUserImageTx(ctx, tx, actor.UserID, "avatar_hash", &newHash, "avatar_small_hash")
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
		old, err := readUserImageTx(ctx, tx, "avatar_hash", actor.UserID)
		if err != nil {
			return err
		}
		if old == "" {
			return nil
		}
		if err := decRefTx(ctx, tx, old); err != nil {
			return err
		}
		return setUserImageTx(ctx, tx, actor.UserID, "avatar_hash", nil, "avatar_small_hash")
	})
}

// UploadCover 换个人主页封面 / 背景（拍板 08 第二轮「壁纸替换」）。
//
// 与 UploadAvatar **逐字同构**（读旧值 → 新图 +1 → 旧图 −1 → 写列），只差三件事：
//
//	· 列是 users.cover_hash（0030），没有小图列；
//	· 上限用 PostMax（内容图那一档，2MiB）：封面是横幅，64KiB 的头像上限放不下；
//	· 可见性是公开 —— 它长在个人主页上，给陌生人看的，私有会让主页永远只有占位图。
func (s *Service) UploadCover(ctx context.Context, actor *authz.Actor, in UploadCoverInput) (*CoverResult, error) {
	if err := requireActive(actor); err != nil {
		return nil, err
	}
	hsh, size, mime, w, h, err := s.PutImage(ctx, actor, in.Body, s.cfg.PostMax)
	if err != nil {
		return nil, err
	}
	created := false
	newHash := string(hsh)
	err = db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		old, err := readUserImageTx(ctx, tx, "cover_hash", actor.UserID)
		if err != nil {
			return err
		}
		if old == newHash {
			return nil // 内容没变：不动引用计数，也不动列
		}
		created = true
		owner := actor.UserID
		if _, err := refTx(ctx, tx, newHash, size, mime, w, h, VisibilityPublic, &owner); err != nil {
			return err
		}
		if old != "" {
			if err := decRefTx(ctx, tx, old); err != nil {
				return err
			}
		}
		return setUserImageTx(ctx, tx, actor.UserID, "cover_hash", &newHash)
	})
	if err != nil {
		return nil, err
	}
	return &CoverResult{Hash: newHash, URL: urlOf(newHash), Width: w, Height: h, Size: size, Created: created}, nil
}

// ClearCover 清掉封面列并给旧图 −1。没有封面时是 no-op（幂等）。
func (s *Service) ClearCover(ctx context.Context, actor *authz.Actor) error {
	if err := requireActive(actor); err != nil {
		return err
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		old, err := readUserImageTx(ctx, tx, "cover_hash", actor.UserID)
		if err != nil {
			return err
		}
		if old == "" {
			return nil
		}
		if err := decRefTx(ctx, tx, old); err != nil {
			return err
		}
		return setUserImageTx(ctx, tx, actor.UserID, "cover_hash", nil)
	})
}

// AttachTopicImage：作者本人或持 topic.delete.any；主题必须 normal；每帖 ≤9。
// 数量闸门与插入**同一事务**，靠 topics 行锁串行化（两个并发请求各读 count=8 会双双插入）。
//
// 引用行写 VisibilityPrivate，但**它不是一堵死墙**：canView 的 private 那一支会问
// topicImageLive —— 主题过审（visibility='normal' AND review_state='approved'）之后，
// 这张图对所有人放行。所以「未过审不外泄、过审后可见」由读路径回答，
// 帖子过审不需要重传图片，也不需要谁去翻档。
func (s *Service) AttachTopicImage(ctx context.Context, actor *authz.Actor, in AttachTopicImageInput) (*AttachedImage, error) {
	if err := requireActive(actor); err != nil {
		return nil, err
	}
	if !actor.IsSuper && !actor.Perms.Has(authz.PermTopicCreate) {
		return nil, apperr.ErrForbidden
	}
	hsh, size, mime, w, h, err := s.PutImage(ctx, actor, in.Body, s.cfg.PostMax)
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
		if _, err := refTx(ctx, tx, string(hsh), size, mime, w, h, VisibilityPrivate, &owner); err != nil {
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

// AddPaymentChannel：每用户 ≤5，行锁串行化；引用行的档位是登录可见 + 渠道展示开关（L1，见下面那段）。
func (s *Service) AddPaymentChannel(ctx context.Context, actor *authz.Actor, in AddPaymentChannelInput) (*PaymentChannel, error) {
	if err := requireActive(actor); err != nil {
		return nil, err
	}
	label := sanitizeLabel(in.Label)
	hsh, size, mime, w, h, err := s.PutImage(ctx, actor, in.Body, s.cfg.PaymentMax)
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
		// L1（拍板第二/三轮，用户两次强调「按渠道显示、不许偏移」）：档位是**老站那一档登录可见**
		// （site/.../pages_profile.rs 的 set_blob_visibility(..., 1)），**不是在上传那一刻定死**的 ——
		// canView 读作者侧的渠道展示开关（user_donation_settings.show_channels），在**读路径上**调档：
		//   开关开 → 登录用户与游客都真拿得到（打赏面板要能扫，扫码付款不需要账号）；
		//   开关关 → 拿不到（占位图）—— 渠道列表本来也回空数组，没有别的合法入口。
		// 写死 public（K2-A 上一轮的做法，已被用户判为偏移）会让档位与开关脱钩：
		// 作者关掉展示之后，图仍然对全站可读。
		owner := actor.UserID
		if _, err := refTx(ctx, tx, string(hsh), size, mime, w, h, VisibilityLogin, &owner); err != nil {
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
		// D24（2026-10-15 用户实测）：上传即默认显示 —— 不这么做，用户传完码别人主页上什么都没有，
		// 还得去设置页开一个自己不知道存在的开关（default false 是 0011 沿用的老站口径，已不适用）。
		if err := turnChannelDisplayOn(ctx, tx, actor.UserID); err != nil {
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
// 收款码的图是 public（L1），所以列表里的 URL 拿给谁都能真取到 —— 列表本身要不要对外给，
// 由 reward 域的 show_channels 开关决定（那条端点回空数组）。
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

// ReadImageBytes 是**站内读者**的取字节口（D33③：AI 审核要把配图随审核请求发给模型）。
//
// 与 GET /img/{hash} 的分工：同一行 images、同一个 store（**磁盘路径由 store 自己拼**，
// 本函数绝不碰目录布局），但**不过 canView** —— 那条可见性规则是给浏览器的；这里的读者是审核链路，
// 它本来就在读同一篇帖子的正文。也**不回落占位图**：把占位图发给模型等于让它审一张假图。
//
// 读不到（行不在 / 行在文件丢）返回 ErrNotFound，调用方据此**转人工**（不是违规、也不是整帖判失败）。
func (s *Service) ReadImageBytes(ctx context.Context, hash string) ([]byte, string, error) {
	if !isHash(hash) {
		return nil, "", ErrBadType.WithMsg("图片地址不正确")
	}
	meta, err := imageMeta(ctx, s.db, hash)
	if err != nil {
		return nil, "", err
	}
	if meta == nil {
		return nil, "", ErrNotFound
	}
	rc, err := s.store.Open(ctx, image.Hash(hash))
	if errors.Is(err, image.ErrNotFound) {
		// 行在文件丢：运维事故，不是用户错（与 FetchImage 同一判）
		s.log.Error("图片行在但文件不在", "hash", hash)
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = rc.Close() }()
	body, err := io.ReadAll(io.LimitReader(rc, readImageMaxBytes))
	if err != nil {
		return nil, "", err
	}
	if int64(len(body)) >= readImageMaxBytes {
		// 内存闸门（不是业务上限）：见 readImageMaxBytes 的注释。
		return nil, "", ErrTooLarge
	}
	return body, meta.Mime, nil
}

// readImageMaxBytes 是站内读口的内存闸门，**不是业务上限**：它比任何上传口的上限都大一个量级，
// 只为挡住「images 里有一行几百 MB 的东西」。业务上限（一次发几张、每张多大）在 aireview ——
// 它才是那条策略的唯一真源，media 不替它做决定。
const readImageMaxBytes = 32 << 20

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
	if !s.canView(ctx, actor, meta) {
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

// EnsureAsset 把一份**站点自带的素材**写进内容寻址存储并登记 images 行，**不碰引用计数**。
//
// 为什么需要它：内置素材（分区图标）是运维/代码带进来的字节，不是用户上传 —— 没有 actor，
// 也就走不了 PutImage（那里要求已激活用户，因为上传是信任边界）。判类型与尺寸仍然照做（判字节）。
//
// created=false 表示这一行本来就在库里（内容寻址：同一份内容只落一行、只写一次）。
//
// 与 refTx 的差别只有一处，但正是它把这件事做成幂等的：**已存在就不动引用计数**
// （`ON CONFLICT DO NOTHING`，不是 `refcount + 1`）。「再登记一次素材」不是一次新引用 ——
// 素材的引用只来自域表（boards.cover_hash 由 forum 域用 IncRefTx 维护，d5 §4.3）。
// 用 refTx 的话每跑一次导入就多一次引用，而 refcount 只增不减 → 那张图永远不被 image:gc 回收。
//
// owner_id = NULL：站点素材没有作者（owner_id 是 FK，写 0 会直接违反 fk_images_owner）。
//
// 用法唯一：forum board-covers 导入命令（app/board_covers.go）。它只处理**仓库里带过来的**固定素材。
func (s *Service) EnsureAsset(ctx context.Context, body []byte, maxBytes int64) (image.Hash, bool, error) {
	mime, w, h, err := sniff(body, maxBytes, int64(len(body)))
	if err != nil {
		return "", false, err
	}
	hsh, size, err := s.store.Put(ctx, bytes.NewReader(body), maxBytes)
	if err != nil {
		return "", false, mapStoreErr(err)
	}
	// 用 QueryContext 而不是 ExecContext：CTE 的 RETURNING 有行 = 这次真的插进去了。
	// 「行早就有了」与「这次新建」对调用方是两件事（导入命令靠它报 images_created）。
	rows, err := s.db.QueryContext(ctx, `
WITH ins AS (
  INSERT INTO images (hash, size, mime, width, height, refcount, visibility, owner_id, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, 0, $6, NULL, now(), now())
  ON CONFLICT (hash) DO NOTHING
  RETURNING hash)
SELECT hash FROM ins`,
		string(hsh), size, mime, w, h, VisibilityPublic)
	if err != nil {
		return "", false, fmt.Errorf("media: ensure asset %s: %w", hsh, err)
	}
	defer rows.Close()
	return hsh, rows.Next(), nil
}

// IncRefTx / DecRefTx 是给别的域的唯一两个方法（d5 §4.3）：
// 引用行在谁的表里，谁负责在同一事务里调它们。±1 不许自己写 SQL。
func (s *Service) IncRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error {
	return incRef(ctx, tx, string(h))
}

func (s *Service) DecRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error {
	return decRefTx(ctx, tx, string(h))
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
//
// 收款码那一档（VisibilityLogin）是唯一的例外，L1 拍板「按渠道显示」：
//
//	· 作者本人 / 超管照旧拿得到（设置页要预览自己的码）；
//	· 其余人（含**游客**）由作者的渠道展示开关决定 —— 开着就放行，关着就是占位图。
//
// 调档发生在**读路径**上，所以档位在上传之后仍然可以调整（同一张码不用重传）。
// 多出来的那一次库读只在「有主的图」这一支上发生（头像 / 封面 / 配图都在这一支），不引入新依赖。
func (s *Service) canView(ctx context.Context, actor *authz.Actor, img *imageRow) bool {
	switch img.Visibility {
	case VisibilityPublic:
		return true
	case VisibilityLogin:
		if actor != nil && (actor.IsSuper || (img.OwnerID != nil && *img.OwnerID == actor.UserID)) {
			return true
		}
		return s.channelDisplayed(ctx, img)
	case VisibilityPrivate:
		if actor != nil && (actor.IsSuper || actor.Perms.Has(authz.PermRewardVerify)) {
			return true
		}
		if actor != nil && actor.UserID != 0 && img.OwnerID != nil && *img.OwnerID == actor.UserID {
			return true
		}
		// 帖子配图随**主题的审核态**放行（拍板第三轮「图文帖整块做完」）：未过审只有作者与
		// 管理员看得到，过审之后正文里的 <img> 与列表封面才对所有人成立 —— 判定在读路径上，
		// 所以帖子过审不需要重传图片，也没有「翻档」这一步要维护。
		return s.topicImageLive(ctx, img)
	}
	return false
}

// topicImageLive 回答「这张私有图是某个**已公开**主题的配图吗」。
// 「已公开」与列表/详情用的是同一条判据（forum 的公开流）：visibility='normal' AND review_state='approved'。
// 只 READ forum 域的两列，不写。
func (s *Service) topicImageLive(ctx context.Context, img *imageRow) bool {
	ok, err := topicImagePubliclyVisible(ctx, s.db, img.Hash)
	if err != nil {
		// 与收款码同一条口径：可见性是信任边界，读不出来就不放行。
		s.log.Error("读配图所属主题的审核态失败，按不可见处理", "hash", img.Hash, "err", err.Error())
		return false
	}
	return ok
}

// channelDisplayed 回答「这张登录可见的图，它的作者开着渠道展示开关吗」。
// 不是收款码的图（将来别人写别的 login 档图）由调用方按原档位办，这里不替它们做主。
func (s *Service) channelDisplayed(ctx context.Context, img *imageRow) bool {
	if img.OwnerID == nil {
		return false
	}
	ok, err := channelImageWithDisplayOn(ctx, s.db, img.Hash, *img.OwnerID)
	if err != nil {
		// 库出错时按**不放行**处理：可见性是信任边界，宁可给占位图也不越权直出。
		s.log.Error("读收款码展示开关失败，按不可见处理", "hash", img.Hash, "err", err.Error())
		return false
	}
	return ok
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
