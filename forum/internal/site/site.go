// Package site 是站点设置域：设置键值、域名登记、公告、横幅、Markdown 预览。
//
// 依据：完全重构/后端设计/d6-reward.md §5.4 / §6.7–§6.9 / §7.10–§7.14；
// 跨域约定：Setting / SettingInt / SettingBool 是**别的模块读站点开关的唯一入口**，
// 它们不直接查 site_settings（拍板 §5 跨域约定 / d6 §3 第 1 条）。
package site

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"sync"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/ent/announcement"
	"forum/internal/ent/banner"
	"forum/internal/ent/bannerdismissal"
	"forum/internal/ent/bannerrole"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	"forum/internal/platform/clock"
	"forum/internal/platform/idgen"
	"forum/internal/platform/markdown"
	"forum/internal/site/pgsql"
)

// 审计 action（d6 §1.1 的写入点清单；字符串一处定义）。
const (
	actionSettingUpdate      = "site.setting.update"
	actionAnnouncementCreate = "announcement.create"
	actionAnnouncementUpdate = "announcement.update"
	actionBannerCreate       = "banner.create"
	actionBannerUpdate       = "banner.update"
)

// 首页与后台列表的条数上限（d6 §6.8：公告只给最近 3 条；横幅最多 5 条）。
const (
	homeAnnouncementLimit = 3
	maxActiveBanners      = 5
)

// Service 是站点域的全部业务逻辑。actor 由 handler 显式传入（拍板 §5.3），不从 context 取。
type Service struct {
	db      *ent.Client
	pg      *pgsql.Queries
	baseURL string
	audit   *audit.Writer
	clk     clock.Clock
	log     *slog.Logger

	cache  settingsCache
	warned sync.Map // 键 → 已 Warn 过
}

// NewService 的签名就是接线契约：db / 站点 base_url / 审计 / 时钟 / 日志。
func NewService(db *ent.Client, baseURL string, a *audit.Writer, clk clock.Clock, log *slog.Logger) *Service {
	return &Service{
		db: db, pg: pgsql.New(db), baseURL: baseURL,
		audit: a, clk: clk, log: log,
	}
}

// requirePerm 是队列 / CLI 也会走到的兜底判定（不走路由也挡住）。
func requirePerm(actor *authz.Actor, perm string) error {
	if actor == nil || actor.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	if !actor.IsSuper && !actor.Perms.Has(perm) {
		return apperr.ErrForbidden
	}
	return nil
}

// renderMarkdown 是本站唯一的 Markdown 渲染链（platform/markdown：goldmark → bluemonday → mention 改写）。
// 公告与帖子同一套清洗规则；names 传 nil：公告里的提及按写入时的昵称快照显示，不为一条公告去 join users。
func renderMarkdown(src string) (string, error) { return markdown.Render(src, nil) }

// GetSite 是 GET /api/v1/site：站点身份 + 最近 3 条公告 + 生效中的横幅。游客可读。
func (s *Service) GetSite(ctx context.Context, actor *authz.Actor) (*Site, error) {
	out := &Site{
		Name:       s.Setting(ctx, keySiteName),
		Tagline:    s.Setting(ctx, keySiteTagline),
		FooterNote: s.Setting(ctx, keySiteFooter),
	}
	items, err := s.homeAnnouncements(ctx)
	if err != nil {
		return nil, err
	}
	out.Announcements = items
	banners, err := s.activeBanners(ctx, actor)
	if err != nil {
		return nil, err
	}
	out.Banners = banners
	return out, nil
}

// homeAnnouncements 只给 enabled + 已发布的（草稿与停用的不出现在首页）。
func (s *Service) homeAnnouncements(ctx context.Context) ([]AnnouncementBrief, error) {
	rows, err := s.db.Announcement.Query().
		Where(announcement.EnabledEQ(true), announcement.PublishedAtNotNil()).
		Order(ent.Desc(announcement.FieldPublishedAt), ent.Desc(announcement.FieldID)).
		Limit(homeAnnouncementLimit).
		All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读公告: %w", err)
	}
	out := make([]AnnouncementBrief, 0, len(rows))
	for _, r := range rows {
		out = append(out, AnnouncementBrief{
			ID: r.PublicID.String(), Title: r.Title, BodyHTML: r.BodyHTML, PublishedAt: r.PublishedAt,
		})
	}
	return out, nil
}

// activeBanners 是「生效中的横幅」（d6 §6.8）：enabled + 时间窗口内 + 定向命中 + 没被关掉。
// 游客只看无定向的横幅（定向横幅对游客不可见）。
func (s *Service) activeBanners(ctx context.Context, actor *authz.Actor) ([]BannerView, error) {
	now := s.clk.Now()
	q := s.db.Banner.Query().Where(
		banner.EnabledEQ(true),
		banner.StartsAtLTE(now),
		banner.Or(banner.EndsAtIsNil(), banner.EndsAtGT(now)),
	)
	if actor == nil || actor.UserID == 0 {
		q = q.Where(banner.Not(banner.HasRoles()))
	} else {
		// banner_roles 没有行 = 所有人（拍板 §8.11 U10）；有行则必须命中我的角色
		q = q.Where(banner.Or(
			banner.Not(banner.HasRoles()),
			banner.HasRolesWith(bannerrole.RoleIDEQ(actor.RoleID)),
		))
		q = q.Where(banner.Not(banner.HasDismissalsWith(bannerdismissal.UserIDEQ(actor.UserID))))
	}
	rows, err := q.Order(ent.Asc(banner.FieldID)).Limit(maxActiveBanners).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("读横幅: %w", err)
	}
	out := make([]BannerView, 0, len(rows))
	for _, r := range rows {
		v := BannerView{ID: r.PublicID.String(), Kind: r.Kind, Text: r.Text}
		if r.URL != nil {
			v.URL = *r.URL
		}
		out = append(out, v)
	}
	return out, nil
}

// DismissBanner 是「不再显示」：幂等，永远成功（d6 §7.11）。
func (s *Service) DismissBanner(ctx context.Context, actor *authz.Actor, publicID string) error {
	if actor == nil || actor.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	pid, err := idgen.ParsePublicID(publicID)
	if err != nil {
		// 格式不对 = 这个横幅不存在，不是参数错（前端拿到的是我们发出去的 id）
		return apperr.ErrNotFound
	}
	// 先确认横幅存在：不然外键冲突会变成 500（d6 §7.11）
	row, err := s.db.Banner.Query().Where(banner.PublicIDEQ(pid)).Select(banner.FieldID).Only(ctx)
	if ent.IsNotFound(err) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("读横幅: %w", err)
	}
	return s.pg.InsertDismissal(ctx, row.ID, actor.UserID, s.clk.Now())
}

// RenderMarkdown 是 POST /api/v1/markdown/preview：站点级内容工具（拍板 §8.11 U9）。
func (s *Service) RenderMarkdown(ctx context.Context, actor *authz.Actor, in PreviewInput) (*Preview, error) {
	if actor == nil || actor.UserID == 0 {
		return nil, apperr.ErrUnauthorized
	}
	html, err := renderMarkdown(in.BodyMD)
	if err != nil {
		return nil, fmt.Errorf("渲染 Markdown: %w", err)
	}
	return &Preview{BodyHTML: html}, nil
}

// ListDomains 是 GET /admin/site-domains：只读。真源是配置里的 base_url（拍板 §8.11 U2）。
func (s *Service) ListDomains(ctx context.Context, actor *authz.Actor) ([]Domain, error) {
	if err := requirePerm(actor, authz.PermSiteSetting); err != nil {
		return nil, err
	}
	list, err := s.pg.Domains(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Domain, 0, len(list))
	for _, d := range list {
		out = append(out, Domain{Domain: d})
	}
	return out, nil
}

// RegisterBaseDomain 在启动时把 base_url 的 host 登记进白名单（d6 §6.9）。
//
// **只 Warn，不拒绝启动**：缺它的表现是「某些域名的站内链接不解析」，不是安全问题；
// 拒绝启动会让人进不去修。
func (s *Service) RegisterBaseDomain(ctx context.Context) error {
	host := baseHost(s.baseURL)
	if host == "" {
		s.log.Warn("base_url 未配置或不可解析，跳过域名登记（站内链接解析与发信回跳只认 base_url）",
			"base_url", s.baseURL)
		return nil
	}
	created, err := s.pg.InsertDomain(ctx, host, s.clk.Now())
	if err != nil {
		return fmt.Errorf("登记 base_url 域名: %w", err)
	}
	if created {
		s.log.Warn("已自动登记 base_url 域名", "domain", host)
	}
	return nil
}

// baseHost 从 base_url 里取 host：去 scheme、去端口、转小写（写入前归一化，d6 §3.2）。
func baseHost(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// validBannerURL 是横幅链接的信任边界校验（d6 §6.8）：只接受 http/https 绝对地址，
// 或站内相对路径（以 / 开头且不以 // 开头——//evil.com 是协议相对外链）。
// javascript: / data: 会被前端直接放进 <a href>，必须在这里挡住。
func validBannerURL(raw string) bool {
	if raw == "" {
		return true
	}
	if strings.HasPrefix(raw, "/") {
		return !strings.HasPrefix(raw, "//")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}
