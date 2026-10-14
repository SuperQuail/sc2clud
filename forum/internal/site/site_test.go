package site_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/audit"
	"forum/internal/platform/clock"
	"forum/internal/site"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

type harness struct {
	t      *testing.T
	ctx    context.Context
	pool   *pgxpool.Pool
	db     *ent.Client
	svc    *site.Service
	clk    *clock.Fake
	userID int64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	applyMigrations(t, ctx, pool)
	db := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = db.Close() })

	h := &harness{
		t: t, ctx: ctx, pool: pool, db: db,
		clk: &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)},
	}
	h.svc = site.NewService(db, "https://sc2clud.cn", audit.New(db, h.clk), h.clk, testLogger())
	var roleID int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM roles ORDER BY id LIMIT 1").Scan(&roleID); err != nil {
		t.Fatalf("读角色: %v", err)
	}
	if err := h.pool.QueryRow(h.ctx,
		`INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
		 VALUES ($1::uuid, 'admin', 'admin@example.com', 'x', '管理员', $2::bigint) RETURNING id`,
		uuid.New(), roleID).Scan(&h.userID); err != nil {
		t.Fatalf("建用户: %v", err)
	}
	return h
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

func applyMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".up.sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("迁移 %s: %v", name, err)
		}
	}
}

func (h *harness) actor(perms ...string) *authz.Actor {
	return &authz.Actor{UserID: h.userID, Perms: authz.NewSet(perms...), Status: "active"}
}

func (h *harness) adminActor() *authz.Actor {
	return h.actor(authz.PermSiteSetting)
}

func (h *harness) mustExec(sqlText string, args ...any) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx, sqlText, args...); err != nil {
		h.t.Fatalf("执行 %q: %v", sqlText, err)
	}
}

func (h *harness) scalar(sqlText string, args ...any) int64 {
	h.t.Helper()
	var n int64
	if err := h.pool.QueryRow(h.ctx, sqlText, args...).Scan(&n); err != nil {
		h.t.Fatalf("标量查询 %q: %v", sqlText, err)
	}
	return n
}

func (h *harness) roleID(key string) int64 {
	h.t.Helper()
	var id int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM roles WHERE key = $1::varchar", key).Scan(&id); err != nil {
		h.t.Fatalf("读角色 %s: %v", key, err)
	}
	return id
}

// ============================================================
// 站点设置
// ============================================================

func TestSettingDefaultsBadValuesAndCache(t *testing.T) {
	h := newHarness(t)

	if got := h.svc.Setting(h.ctx, "site.name"); got != "SC2clud 战役作者社区" {
		t.Fatalf("缺行时 site.name = %q，想要代码里的默认值", got)
	}
	if got := h.svc.Setting(h.ctx, "不存在的键"); got != "" {
		t.Fatalf("未声明的键应当返回空串，实际 %q", got)
	}
	if !h.svc.SettingBool(h.ctx, "mail.enabled") {
		t.Fatal("mail.enabled 缺行时默认应当是开")
	}

	// 坏值（toggle 不是 on/off）→ 按默认值走，不 panic、不 500
	h.mustExec("INSERT INTO site_settings (key, value) VALUES ('registration.open', 'yes')")
	if got := h.svc.Setting(h.ctx, "registration.open"); got != "on" {
		t.Fatalf("坏值应当回落到默认值 on，实际 %q", got)
	}

	// 缓存：绕过 service 直接改库，30 秒内读到的还是旧值；过期后读到新值。
	// 先把时钟推过 TTL：前面几次读已经把整表缓存填上了（缓存粒度是整表，d6 §8.1）。
	h.clk.T = h.clk.T.Add(31 * time.Second)
	h.mustExec("INSERT INTO site_settings (key, value) VALUES ('site.tagline', '旧简介')")
	if got := h.svc.Setting(h.ctx, "site.tagline"); got != "旧简介" {
		t.Fatalf("第一次读 = %q，想要 旧简介", got)
	}
	h.mustExec("UPDATE site_settings SET value = '新简介' WHERE key = 'site.tagline'")
	if got := h.svc.Setting(h.ctx, "site.tagline"); got != "旧简介" {
		t.Fatalf("TTL 内应当读缓存里的旧值，实际 %q", got)
	}
	h.clk.T = h.clk.T.Add(31 * time.Second)
	if got := h.svc.Setting(h.ctx, "site.tagline"); got != "新简介" {
		t.Fatalf("TTL 过期后应当读到新值，实际 %q", got)
	}
}

func TestUpdateSettingsValidationWritesNothing(t *testing.T) {
	h := newHarness(t)

	// 未知 key → 400 + fields，且一个字节都不写
	err := h.svc.UpdateSettings(h.ctx, h.adminActor(), site.SettingsInput{
		Values: map[string]string{"site.name": "新名字", "made.up.key": "x"},
	})
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Status != 400 {
		t.Fatalf("未知 key: err = %v，想要 400", err)
	}
	if ae.Fields["made.up.key"] == "" {
		t.Fatalf("fields 里应当指出是哪个 key：%+v", ae.Fields)
	}
	if n := h.scalar("SELECT count(*) FROM site_settings"); n != 0 {
		t.Fatalf("全验后写：校验失败时不该写任何行，实际 %d 行", n)
	}

	// 已知 key 的非法值 → 400，也不写
	if err := h.svc.UpdateSettings(h.ctx, h.adminActor(), site.SettingsInput{
		Values: map[string]string{"registration.open": "yes"},
	}); err == nil {
		t.Fatal("toggle 的非法值应当 400")
	}
	if n := h.scalar("SELECT count(*) FROM site_settings"); n != 0 {
		t.Fatalf("非法值不该写库，实际 %d 行", n)
	}

	// 值过长 → 400
	if err := h.svc.UpdateSettings(h.ctx, h.adminActor(), site.SettingsInput{
		Values: map[string]string{"site.tagline": strings.Repeat("x", 2001)},
	}); err == nil {
		t.Fatal("超长值应当 400")
	}
	if n := h.scalar("SELECT count(*) FROM site_settings"); n != 0 {
		t.Fatalf("超长值不该写库，实际 %d 行", n)
	}
}

func TestUpdateSettingsWritesAuditsAndInvalidatesCache(t *testing.T) {
	h := newHarness(t)
	// 先读一次，把缓存填上
	if got := h.svc.Setting(h.ctx, "site.name"); got == "" {
		t.Fatal("默认值不该是空")
	}

	err := h.svc.UpdateSettings(h.ctx, h.adminActor(), site.SettingsInput{
		Values: map[string]string{"site.name": "新站名", "registration.open": "off"},
		IP:     "203.0.113.5",
	})
	if err != nil {
		t.Fatal(err)
	}
	// 立即生效（写完 Invalidate）
	if got := h.svc.Setting(h.ctx, "site.name"); got != "新站名" {
		t.Fatalf("写完立刻读 = %q，想要 新站名", got)
	}
	if h.svc.SettingBool(h.ctx, "registration.open") {
		t.Fatal("registration.open=off 应当是关")
	}
	// 每个 key 一条审计（d6 §6.7）
	if n := h.scalar("SELECT count(*) FROM audit_logs WHERE action = 'site.setting.update'"); n != 2 {
		t.Fatalf("审计行数 = %d，想要 2（每 key 一条）", n)
	}
	if n := h.scalar("SELECT count(*) FROM site_settings"); n != 2 {
		t.Fatalf("site_settings 行数 = %d，想要 2", n)
	}
}

func TestSettingsPermissionDenied(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.GetSettings(h.ctx, h.actor()); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("没有 site.setting 时 GetSettings = %v，想要 403", err)
	}
	if err := h.svc.UpdateSettings(h.ctx, h.actor(), site.SettingsInput{
		Values: map[string]string{"site.name": "x"},
	}); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("没有 site.setting 时 UpdateSettings = %v，想要 403", err)
	}
	if err := h.svc.UpdateSettings(h.ctx, nil, site.SettingsInput{
		Values: map[string]string{"site.name": "x"},
	}); !errors.Is(err, apperr.ErrUnauthorized) {
		t.Fatalf("nil actor = %v，想要 401", err)
	}
}

// TestSettingSpecsMatchFrontendMock：代码里的键值表与前端 mock 的键必须一致（d6 §10 第 53 条），
// 唯一一处例外写在下面（拍板 §12.2 用一个开关取代了 registration.require_activation）。
func TestSettingSpecsMatchFrontendMock(t *testing.T) {
	// 设置清单有两份 mock：站点设置（system.ts）与 AI 审核的阈值（mock/ai.ts，2026-10-14 从 system.ts 搬出）。
	// 两个文件都要读 —— 只读一个会得到「mock 里找不到 AI_THRESHOLDS」这种与事实无关的红。
	mockKeys := map[string]bool{}
	for _, f := range [][2]string{
		{filepath.Join("..", "..", "..", "web", "src", "devroom", "pages", "15-admin", "mock", "system.ts"), "SITE_SETTINGS"},
		{filepath.Join("..", "..", "..", "web", "src", "devroom", "pages", "15-admin", "mock", "ai.ts"), "AI_THRESHOLDS"},
	} {
		raw, err := os.ReadFile(f[0])
		if err != nil {
			t.Fatalf("读前端 mock %s: %v", f[0], err)
		}
		body := tsArrayBody(t, string(raw), f[1])
		for _, m := range regexp.MustCompile(`key: '([^']+)'`).FindAllStringSubmatch(body, -1) {
			mockKeys[m[1]] = true
		}
	}
	if len(mockKeys) == 0 {
		t.Fatal("没有从 mock 里解析出任何 key —— 解析逻辑坏了，这条检查就成了假绿")
	}

	// 拍板 §12.2：注册激活模式由 auth.registration.auto_activate 一个开关决定，
	// mock 里那条旧的 registration.require_activation 随之作废（前端改完后删掉这一行）。
	superseded := map[string]string{"registration.require_activation": "auth.registration.auto_activate"}
	for old := range superseded {
		if !mockKeys[old] {
			continue
		}
		delete(mockKeys, old)
		mockKeys[superseded[old]] = true
	}

	specKeys := map[string]bool{}
	for _, sp := range site.SettingSpecs() {
		specKeys[sp.Key] = true
	}
	if diff := diffKeys(mockKeys, specKeys); len(diff) > 0 {
		t.Fatalf("前端 mock 与 SettingSpecs() 不一致：%v", diff)
	}
	for _, sp := range site.SettingSpecs() {
		if sp.Kind == "int" && (sp.Min == 0 || sp.Max == 0) {
			t.Fatalf("int 键 %s 没有声明值域", sp.Key)
		}
	}
}

// tsArrayBody 切出 "export const <name> … ]" 之间的内容（避免把 AI_PROVIDERS 之类的 key 也算进来）。
func tsArrayBody(t *testing.T, src, name string) string {
	t.Helper()
	marker := "export const " + name
	i := strings.Index(src, marker)
	if i < 0 {
		t.Fatalf("mock 里找不到 %s", name)
	}
	rest := src[i:]
	end := strings.Index(rest, "\n];")
	if end < 0 {
		t.Fatalf("mock 里 %s 的数组没有结束", name)
	}
	return rest[:end]
}

func diffKeys(want, got map[string]bool) []string {
	var out []string
	for k := range want {
		if !got[k] {
			out = append(out, "mock 有而代码没有: "+k)
		}
	}
	for k := range got {
		if !want[k] {
			out = append(out, "代码有而 mock 没有: "+k)
		}
	}
	sort.Strings(out)
	return out
}

// ============================================================
// 横幅与公告
// ============================================================

func TestActiveBannersVisibilityAndDismiss(t *testing.T) {
	h := newHarness(t)
	past := h.clk.Now().Add(-time.Hour)
	future := h.clk.Now().Add(time.Hour)
	ended := h.clk.Now().Add(-time.Minute)

	all := h.newBanner(site.BannerInput{Kind: "info", Text: "所有人可见"})
	targeted := h.newBanner(site.BannerInput{Kind: "warning", Text: "仅管理员", Roles: []string{"admin"}})
	h.newBanner(site.BannerInput{Kind: "info", Text: "还没开始", StartsAt: &future})
	h.newBanner(site.BannerInput{Kind: "info", Text: "已经结束", StartsAt: &past, EndsAt: &ended})
	off := false
	h.newBanner(site.BannerInput{Kind: "info", Text: "停用的", Enabled: &off})

	guest, err := h.svc.GetSite(h.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	texts := bannerTexts(guest.Banners)
	if len(texts) != 1 || texts[0] != "所有人可见" {
		t.Fatalf("游客可见横幅 = %v，想要 [所有人可见]（定向/未来/过期/停用的都不可见）", texts)
	}

	// 管理员（admin 角色）能看到定向给他的那一条
	adminActor := h.actor()
	adminActor.RoleID = h.roleID("admin")
	adminView, err := h.svc.GetSite(h.ctx, adminActor)
	if err != nil {
		t.Fatal(err)
	}
	texts = bannerTexts(adminView.Banners)
	if len(texts) != 2 {
		t.Fatalf("管理员可见横幅 = %v，想要 2 条", texts)
	}

	// dismiss 幂等：连点三次都成功，表里只有一行
	for i := 0; i < 3; i++ {
		if err := h.svc.DismissBanner(h.ctx, adminActor, all); err != nil {
			t.Fatalf("第 %d 次 dismiss: %v", i+1, err)
		}
	}
	if n := h.scalar("SELECT count(*) FROM banner_dismissals"); n != 1 {
		t.Fatalf("dismiss 之后行数 = %d，想要 1", n)
	}
	after, err := h.svc.GetSite(h.ctx, adminActor)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range after.Banners {
		if v.ID == all {
			t.Fatal("关掉之后不该再出现")
		}
	}
	if targeted == "" {
		t.Fatal("定向横幅应当被创建出来")
	}

	// 不存在的横幅 → 404（而不是外键冲突 500）
	if err := h.svc.DismissBanner(h.ctx, adminActor, uuid.NewString()); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("dismiss 不存在的横幅 = %v，想要 404", err)
	}
}

func TestBannerURLValidation(t *testing.T) {
	h := newHarness(t)
	for _, bad := range []string{"javascript:alert(1)", "//evil.com", "data:text/html,x"} {
		_, err := h.svc.CreateBanner(h.ctx, h.adminActor(), site.BannerInput{Kind: "info", Text: "t", URL: bad})
		if !errors.Is(err, site.ErrBadURL) {
			t.Fatalf("url=%q: err = %v，想要 site.bad_url", bad, err)
		}
	}
	for _, ok := range []string{"https://example.com/x", "/topics/1", ""} {
		if _, err := h.svc.CreateBanner(h.ctx, h.adminActor(), site.BannerInput{Kind: "info", Text: "t", URL: ok}); err != nil {
			t.Fatalf("url=%q 应当合法: %v", ok, err)
		}
	}
}

func TestAnnouncementsDraftAndSanitize(t *testing.T) {
	h := newHarness(t)
	draft := false
	created, err := h.svc.CreateAnnouncement(h.ctx, h.adminActor(), site.AnnouncementInput{
		Title: "草稿", BodyMD: "正文 <script>alert(1)</script> **加粗**", Publish: &draft,
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.PublishedAt != nil {
		t.Fatal("草稿的 published_at 应当是 NULL")
	}
	if strings.Contains(created.BodyHTML, "<script") {
		t.Fatalf("<script> 必须被清洗掉: %s", created.BodyHTML)
	}
	if !strings.Contains(created.BodyHTML, "<strong>") {
		t.Fatalf("Markdown 应当被渲染: %s", created.BodyHTML)
	}

	home, err := h.svc.GetSite(h.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(home.Announcements) != 0 {
		t.Fatalf("草稿不该出现在首页，实际 %d 条", len(home.Announcements))
	}

	// 发布 → 出现在首页；停用 → 又消失
	yes := true
	if _, err := h.svc.UpdateAnnouncement(h.ctx, h.adminActor(), created.ID, site.AnnouncementPatch{Publish: &yes}); err != nil {
		t.Fatal(err)
	}
	home, _ = h.svc.GetSite(h.ctx, nil)
	if len(home.Announcements) != 1 {
		t.Fatalf("发布之后首页应当有 1 条，实际 %d", len(home.Announcements))
	}
	no := false
	if _, err := h.svc.UpdateAnnouncement(h.ctx, h.adminActor(), created.ID, site.AnnouncementPatch{Enabled: &no}); err != nil {
		t.Fatal(err)
	}
	home, _ = h.svc.GetSite(h.ctx, nil)
	if len(home.Announcements) != 0 {
		t.Fatalf("停用之后首页不该有公告，实际 %d", len(home.Announcements))
	}
	// 审计：建一条 + 改两次
	if n := h.scalar("SELECT count(*) FROM audit_logs WHERE target_type = 'announcement'"); n != 3 {
		t.Fatalf("公告审计行数 = %d，想要 3", n)
	}
}

func TestRegisterBaseDomain(t *testing.T) {
	h := newHarness(t)
	if err := h.svc.RegisterBaseDomain(h.ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.RegisterBaseDomain(h.ctx); err != nil {
		t.Fatal(err)
	}
	if n := h.scalar("SELECT count(*) FROM site_domains"); n != 1 {
		t.Fatalf("登记两次之后行数 = %d，想要 1（幂等）", n)
	}
	var domain string
	if err := h.pool.QueryRow(h.ctx, "SELECT domain FROM site_domains").Scan(&domain); err != nil {
		t.Fatal(err)
	}
	if domain != "sc2clud.cn" {
		t.Fatalf("登记的域名 = %q，想要 sc2clud.cn（去 scheme、去端口、小写）", domain)
	}

	// base_url 不可解析：只 Warn，不报错
	empty := site.NewService(h.db, "", audit.New(h.db, h.clk), h.clk, testLogger())
	if err := empty.RegisterBaseDomain(h.ctx); err != nil {
		t.Fatalf("base_url 为空应当只 Warn，实际 %v", err)
	}
	list, err := h.svc.ListDomains(h.ctx, h.adminActor())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("域名列表 = %v，想要 1 条", list)
	}
}

// newBanner 建一条横幅并返回它的对外 id。
func (h *harness) newBanner(in site.BannerInput) string {
	h.t.Helper()
	out, err := h.svc.CreateBanner(h.ctx, h.adminActor(), in)
	if err != nil {
		h.t.Fatalf("建横幅 %s: %v", in.Text, err)
	}
	return out.ID
}

func bannerTexts(views []site.BannerView) []string {
	out := make([]string, 0, len(views))
	for _, v := range views {
		out = append(out, v.Text)
	}
	sort.Strings(out)
	return out
}
