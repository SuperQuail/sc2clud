// Package release 是启动器下载索引：版本、平台产物、302 转链与下载计数。
//
// 本站**不承载产物字节**（后端方案第 11 章）：release_assets.url 是外部直链，本站只做 302。
// 依据：完全重构/后端设计/d5-content.md §5、交接单 §1.5。
package release

import (
	"context"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/counter"
	"forum/internal/platform/db"
)

// 状态机（d5 §5.4）：draft → published ⇄ archived；draft → archived 也允许。
const (
	StatusDraft     = "draft"
	StatusPublished = "published"
	StatusArchived  = "archived"
)

// 通道只有两个（ck_releases_channel）。
const (
	ChannelStable = "stable"
	ChannelBeta   = "beta"
)

// 版本号形如 1.2.3 / 1.2.3-beta.1。
var versionRe = regexp.MustCompile(`^\d+(\d+)*([-+][0-9A-Za-z.-]+)?$`)

var sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Service 是下载域的全部业务逻辑。actor 由 handler 显式传入（拍板 §5.3）。
type Service struct {
	db      *ent.Client
	counter Counter
	clk     clock.Clock
	log     *slog.Logger
}

// NewService 的签名就是接线契约。
func NewService(db *ent.Client, c Counter, clk clock.Clock, log *slog.Logger) *Service {
	return &Service{db: db, counter: c, clk: clk, log: log}
}

// Latest 是最新发布的 stable（channel 空则按 stable）。
func (s *Service) Latest(ctx context.Context, channel string) (*ReleaseDetail, error) {
	if channel == "" {
		channel = ChannelStable
	}
	if channel != ChannelStable && channel != ChannelBeta {
		return nil, invalid("channel", "只支持 stable / beta")
	}
	rel, err := latestRelease(ctx, s.db, channel)
	if err != nil {
		return nil, err
	}
	if rel == nil {
		return nil, ErrNotFound
	}
	if err := s.attachAssets(ctx, []*ReleaseDetail{rel}); err != nil {
		return nil, err
	}
	return rel, nil
}

// ListReleases 是历史版本的游标分页（拍板 §5.1：排序键恒为 (published_at DESC, id DESC)）。
func (s *Service) ListReleases(ctx context.Context, in ListReleasesInput) (*ReleasePage, error) {
	limit := limitOf(in.Limit)
	after, afterID, err := pageCursor(in.Cursor)
	if err != nil {
		return nil, err
	}
	if in.Channel != "" && in.Channel != ChannelStable && in.Channel != ChannelBeta {
		return nil, invalid("channel", "只支持 stable / beta")
	}
	in.Limit = limit
	items, err := listReleases(ctx, s.db, in, after, afterID)
	if err != nil {
		return nil, err
	}
	if err := s.attachAssets(ctx, detailPtrs(items)); err != nil {
		return nil, err
	}
	page := &ReleasePage{Items: items}
	// next_cursor 只在「取满一页」时给（拍板 §5.1）
	if len(items) == limit {
		last := items[len(items)-1]
		if last.PublishedAt != nil {
			page.NextCursor = encodeCursor(*last.PublishedAt, last.rowID)
		}
	}
	return page, nil
}

// ResolveAsset 是 302 的落点：草稿与归档不对外；计数只在**已发布**的转链上 +1（d5 §5.2）。
func (s *Service) ResolveAsset(ctx context.Context, assetPublicID string) (string, error) {
	id, target, status, err := resolveAsset(ctx, s.db, assetPublicID)
	if err != nil {
		return "", err
	}
	if id == 0 || status != StatusPublished {
		return "", ErrNotFound
	}
	s.counter.Add(counter.AssetDownloadKey(id), 1)
	return target, nil
}

// UpsertRelease 录入/更新一个版本。ID 为空 = 新建（按 version 唯一）。
//
// notes_html 由调用方渲染后传入（markdown 管线不是本模块的能力）；
// status 为空 = 不改状态。published_at 只在**首次**进入 published 时写一次。
func (s *Service) UpsertRelease(ctx context.Context, actor *authz.Actor, in UpsertReleaseInput) (*ReleaseDetail, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	in.Version = strings.TrimSpace(in.Version)
	if !versionRe.MatchString(in.Version) {
		return nil, invalid("version", "版本号形如 1.2.3")
	}
	if in.Channel != "" && in.Channel != ChannelStable && in.Channel != ChannelBeta {
		return nil, invalid("channel", "只支持 stable / beta")
	}
	if in.Status != "" && !validStatus(in.Status) {
		return nil, invalid("status", "只支持 draft / published / archived")
	}
	if len(in.NotesMD) > 200_000 {
		return nil, invalid("notes_md", "更新说明太长")
	}

	var out *ReleaseDetail
	err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		var publishedAt *time.Time
		if in.Status == StatusPublished {
			// 首次 publish 写一次；已经是 published 的保留首次时间（d5 §5.4）
			now := s.clk.Now()
			publishedAt = &now
		}
		id, err := upsertRelease(ctx, tx, uuid.New(), in, publishedAt)
		if err != nil {
			if isUniqueViolation(err) {
				return apperr.ErrConflict.WithMsg("这个版本号已经存在")
			}
			return err
		}
		// published 要求至少 1 个产物（d5 §5.4）；不满足就整笔回滚
		if in.Status == StatusPublished {
			n, err := countAssets(ctx, tx, id)
			if err != nil {
				return err
			}
			if n == 0 {
				return invalid("status", "发布前先加至少一个下载源")
			}
		}
		out, err = s.detailTx(ctx, tx, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SetReleaseStatus 是状态机（d5 §5.4）：两端都幂等，重复调用是 no-op 而不是 409。
func (s *Service) SetReleaseStatus(ctx context.Context, actor *authz.Actor, in SetReleaseStatusInput) error {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return err
	}
	if !validStatus(in.Status) {
		return invalid("status", "只支持 draft / published / archived")
	}
	return db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		id, err := releaseIDByPublicID(ctx, tx, in.ID)
		if err != nil {
			return err
		}
		if id == 0 {
			return ErrNotFound
		}
		_, current, publishedAt, err := releaseStatus(ctx, tx, id)
		if err != nil {
			return err
		}
		if current == in.Status {
			return nil // 幂等：状态没变就不动 published_at
		}
		if in.Status == StatusPublished {
			if publishedAt == nil {
				now := s.clk.Now()
				publishedAt = &now
			}
			n, err := countAssets(ctx, tx, id)
			if err != nil {
				return err
			}
			if n == 0 {
				return invalid("status", "发布前先加至少一个下载源")
			}
		} else {
			publishedAt = nil // ck_releases_published_at：非 published 必须为 NULL
		}
		return setReleaseStatus(ctx, tx, id, in.Status, publishedAt)
	})
}

// UpsertAsset 按 (release, platform, arch) 幂等写入。
func (s *Service) UpsertAsset(ctx context.Context, actor *authz.Actor, in UpsertAssetInput) (*Asset, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	in.Platform = strings.TrimSpace(in.Platform)
	in.Arch = strings.TrimSpace(in.Arch)
	if in.Platform == "" || len(in.Platform) > 16 {
		return nil, invalid("platform", "平台名必填且不超过 16 字符")
	}
	if in.Arch == "" || len(in.Arch) > 16 {
		return nil, invalid("arch", "架构名必填且不超过 16 字符")
	}
	if err := checkOutboundURL(in.URL); err != nil {
		return nil, err
	}
	in.SHA256 = strings.ToLower(strings.TrimSpace(in.SHA256))
	if !sha256Re.MatchString(in.SHA256) {
		return nil, invalid("sha256", "必须是 64 位小写十六进制")
	}
	if in.Size < 0 {
		return nil, invalid("size", "不能是负数")
	}
	var out *Asset
	err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
		id, err := releaseIDByPublicID(ctx, tx, in.ReleaseID)
		if err != nil {
			return err
		}
		if id == 0 {
			return ErrNotFound
		}
		a, err := upsertAsset(ctx, tx, id, uuid.New(), in)
		if err != nil {
			return err
		}
		out = &a
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteAsset 硬删一行产物（版本还在，只是少了这个平台的包）。
func (s *Service) DeleteAsset(ctx context.Context, actor *authz.Actor, assetPublicID string) error {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return err
	}
	ok, err := deleteAsset(ctx, s.db, assetPublicID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// FlushDownloads 把内存里的下载增量写回 release_assets（counter.Buffer 每 15 秒调它）。
// 只处理 download:asset: 前缀；别的前缀不归本模块。
func (s *Service) FlushDownloads(ctx context.Context, keys []string, deltas []int64) error {
	ids := make([]int64, 0, len(keys))
	counts := make([]int64, 0, len(keys))
	for i, k := range keys {
		kind, id, err := counter.Kind(k)
		if err != nil {
			s.log.Warn("release: 未知的计数键，跳过", "key", k)
			continue
		}
		if kind != "asset_download" {
			continue
		}
		ids = append(ids, id)
		counts = append(counts, deltas[i])
	}
	if len(ids) == 0 {
		return nil
	}
	return addDownloadCounts(ctx, s.db, ids, counts)
}

// ── 内部 ────────────────────────────────────────────────────────

// attachAssets 给一批版本补产物（1 次往返，不做 N+1）。
func (s *Service) attachAssets(ctx context.Context, list []*ReleaseDetail) error {
	if len(list) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(list))
	for _, r := range list {
		if r.rowID != 0 {
			ids = append(ids, r.rowID)
		}
	}
	byRelease, err := assetsOf(ctx, s.db, ids)
	if err != nil {
		return err
	}
	for _, r := range list {
		r.Assets = byRelease[r.rowID]
		if r.Assets == nil {
			r.Assets = []Asset{}
		}
	}
	return nil
}

// detailTx 在事务内读一个版本的完整形状（事务函数不返回 ent 实体，只回 DTO）。
func (s *Service) detailTx(ctx context.Context, tx *ent.Tx, id int64) (*ReleaseDetail, error) {
	var r ReleaseDetail
	var pid uuid.UUID
	err := row1(ctx, tx, `SELECT public_id, version, channel, notes_md, notes_html, status, published_at, created_at
  FROM releases WHERE id = $1`, []any{id},
		&pid, &r.Version, &r.Channel, &r.NotesMD, &r.NotesHTML, &r.Status, &r.PublishedAt, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	r.ID = pid.String()
	r.rowID = id
	assets, err := assetsOf(ctx, tx, []int64{id})
	if err != nil {
		return nil, err
	}
	r.Assets = assets[id]
	if r.Assets == nil {
		r.Assets = []Asset{}
	}
	return &r, nil
}

// checkOutboundURL 是**信任边界**校验：管理员录入的外部直链。
// 没有它，一条 javascript: / file: 直链就是开放重定向与协议走私（d5 §5.1）。
func checkOutboundURL(raw string) error {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil {
		return invalid("url", "不是合法链接")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return invalid("url", "只接受 http/https 链接")
	}
	if u.User != nil {
		return invalid("url", "链接里不能带用户名密码")
	}
	if u.Host == "" {
		return invalid("url", "链接缺少域名")
	}
	if !strings.Contains(u.Host, ".") {
		return invalid("url", "链接缺少域名")
	}
	return nil
}

func validStatus(s string) bool {
	return s == StatusDraft || s == StatusPublished || s == StatusArchived
}

func limitOf(n int) int {
	switch {
	case n <= 0:
		return defaultLimit
	case n > maxLimit:
		return maxLimit
	default:
		return n
	}
}

func isUniqueViolation(err error) bool {
	return strings.Contains(err.Error(), "SQLSTATE 23505") || strings.Contains(err.Error(), "duplicate key")
}

func detailPtrs(items []ReleaseDetail) []*ReleaseDetail {
	out := make([]*ReleaseDetail, len(items))
	for i := range items {
		out[i] = &items[i]
	}
	return out
}
