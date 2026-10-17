package site

import "time"

// ---- 对外视图（v2 §21.5：JSON 字段名就是契约）----

// SettingItem 是一行站点设置：声明（类型/默认值/取值范围）+ 当前生效值。
// 字段名与前端 UI 的 SiteSetting 类型逐字一致（grp / kind / options / hint）。
type SettingItem struct {
	Key       string     `json:"key"`
	Label     string     `json:"label"`
	Group     string     `json:"grp"`
	Kind      string     `json:"kind"`
	Options   []string   `json:"options,omitempty"`
	Value     string     `json:"value"`
	Hint      string     `json:"hint"`
	UpdatedAt *time.Time `json:"updated_at"`
}

// SettingsView 是 GET /admin/site-settings 的响应：带 schema 的整表。
type SettingsView struct {
	Items []SettingItem `json:"items"`
}

// SettingsInput 是 PATCH /admin/site-settings 的入参：只写传进来的键。
type SettingsInput struct {
	Values map[string]string `json:"values" binding:"required"`
	IP     string            `json:"-"`
}

// Site 是 GET /api/v1/site 的响应：壳与首页要的那几样。
type Site struct {
	Name          string              `json:"name"`
	Tagline       string              `json:"tagline"`
	FooterNote    string              `json:"footer_note"`
	Announcements []AnnouncementBrief `json:"announcements"`
	Banners       []BannerView        `json:"banners"`
}

// Domain 是域名白名单的一行（只读：真源是配置里的 base_url，拍板 §8.11 U2）。
type Domain struct {
	Domain string `json:"domain"`
}

// Preview / PreviewInput：POST /markdown/preview。
type PreviewInput struct {
	BodyMD string `json:"body_md" binding:"required"`
}

type Preview struct {
	BodyHTML string `json:"body_html"`
}

// ---- 公告 ----

// AnnouncementBrief 出现在 GET /site 里（只给已发布的）。
type AnnouncementBrief struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	BodyHTML    string     `json:"body_html"`
	PublishedAt *time.Time `json:"published_at"`
}

// Announcement 是后台列表/详情的完整形态（含草稿与 Markdown 原文）。
type Announcement struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	BodyMD      string     `json:"body_md"`
	BodyHTML    string     `json:"body_html"`
	Enabled     bool       `json:"enabled"`
	PublishedAt *time.Time `json:"published_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type AnnouncementPage struct {
	Items      []Announcement `json:"-"`
	NextCursor string         `json:"-"`
}

type AnnouncementInput struct {
	Title   string `json:"title" binding:"required,max=120"`
	BodyMD  string `json:"body_md" binding:"required"`
	Enabled *bool  `json:"enabled"`
	Publish *bool  `json:"publish"` // true = 立刻发布（published_at = now）
	IP      string `json:"-"`
}

// AnnouncementPatch 是部分更新：nil = 不改。Publish=false 表示下线（published_at 置 NULL）。
type AnnouncementPatch struct {
	Title   *string `json:"title"`
	BodyMD  *string `json:"body_md"`
	Enabled *bool   `json:"enabled"`
	Publish *bool   `json:"publish"`
	IP      string  `json:"-"`
}

// ---- 横幅 ----

// BannerView 是 GET /site 里的一条生效横幅。
type BannerView struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Text string `json:"text"`
	URL  string `json:"url,omitempty"`
}

// Banner 是后台列表的一条（含窗口、开关、定向角色）。
type Banner struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	Text      string     `json:"text"`
	URL       string     `json:"url"`
	StartsAt  time.Time  `json:"starts_at"`
	EndsAt    *time.Time `json:"ends_at"`
	Enabled   bool       `json:"enabled"`
	Roles     []string   `json:"roles"` // 角色 key；空 = 所有人（拍板 §8.11 U10）
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

type BannerPage struct {
	Items      []Banner `json:"-"`
	NextCursor string   `json:"-"`
}

type BannerInput struct {
	Kind     string     `json:"kind" binding:"required,oneof=info warning promo"`
	Text     string     `json:"text" binding:"required,max=200"`
	URL      string     `json:"url"`
	StartsAt *time.Time `json:"starts_at"`
	EndsAt   *time.Time `json:"ends_at"`
	Enabled  *bool      `json:"enabled"`
	Roles    []string   `json:"roles"`
	IP       string     `json:"-"`
}

// BannerPatch 是部分更新。两个「清空」开关是必要的：nil 指针分不出「不改」与「改成 NULL」。
type BannerPatch struct {
	Kind        *string    `json:"kind"`
	Text        *string    `json:"text"`
	URL         *string    `json:"url"` // "" = 清掉链接
	StartsAt    *time.Time `json:"starts_at"`
	EndsAt      *time.Time `json:"ends_at"`
	ClearEndsAt bool       `json:"clear_ends_at"` // 改成永久（ends_at = NULL）
	Enabled     *bool      `json:"enabled"`
	Roles       *[]string  `json:"roles"` // 给了就整表替换定向
	IP          string     `json:"-"`
}
