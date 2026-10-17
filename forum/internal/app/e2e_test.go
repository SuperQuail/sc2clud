package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/auth"
	"forum/internal/authz"
	"forum/internal/config"
	"forum/internal/mail"
	"forum/internal/platform/db"
	"forum/internal/testsupport"
	"forum/migrations"
)

// TestMain 起一个真实 PostgreSQL（embedded-postgres），整个包的用例共用。
func TestMain(m *testing.M) { testsupport.Main(m) }

// logSink 收集 slog 的输出：mail 的 log provider 把整封信（含 6 位验证码）写进日志，
// 验收要的「从 mail 的 log provider 读 6 位码」就是从它这里读。
type logSink struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	read int // 已消费到的位置
}

func (s *logSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *logSink) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// takeCode 取**还没被取过**的第一个验证码：第二个用户不能拿到第一个人的码。
func (s *logSink) takeCode(re *regexp.Regexp) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rest := s.buf.String()[s.read:]
	loc := re.FindStringSubmatchIndex(rest)
	if loc == nil {
		return "", false
	}
	s.read += loc[1]
	return rest[loc[2]:loc[3]], true
}

// codeRe 取的措辞来自 platform/mail/templates/verify_email.txt：「你的邮箱验证码是：{{.Code}}」。
var codeRe = regexp.MustCompile("验证码是：([0-9]{6})")

// apiClient 是带 Cookie 罐的测试客户端：每一步的请求与响应原文都写进测试日志。
type apiClient struct {
	t    *testing.T
	base string
	c    *http.Client
}

func (c *apiClient) do(method, path, body string) (int, string) {
	c.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		c.t.Fatalf("构造请求失败: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.c.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s 失败: %v", method, path, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	c.t.Logf("\n=== %s %s ===\nREQ  %s\nRES  %d\n%s", method, path, body, res.StatusCode, raw)
	return res.StatusCode, string(raw)
}

func (c *apiClient) mustDo(want int, method, path, body string) string {
	c.t.Helper()
	got, raw := c.do(method, path, body)
	if got != want {
		c.t.Fatalf("%s %s: 期望 %d，实际 %d\n%s", method, path, want, got, raw)
	}
	return raw
}

// TestEndToEndMainChain 是上线设计 §2 P1 的验收：注册 → 从 mail 的 log provider 读 6 位码 →
// 激活 → 登录 → 发帖 → 读列表。
//
// 它走的是**真的那条路**：真 PostgreSQL（embedded）→ 全部迁移 → newModules 装配 →
// selfCheck → registerTasks → 队列 worker 真跑 → HTTP handler 真收请求。
// 唯一的例外写在下面每一步里（需要管理员权限的两处前置）。
func TestEndToEndMainChain(t *testing.T) {
	if testing.Short() {
		t.Skip("端到端用例要起真库，-short 跳过")
	}
	ctx := context.Background()
	cfg := e2eConfig(t)

	if err := db.Migrate(ctx, cfg.DB.DSN, migrations.FS()); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}

	// 日志收集：log provider 的验证码从这里取。
	sink := &logSink{}
	log := slog.New(slog.NewTextHandler(sink, &slog.HandlerOptions{Level: slog.LevelInfo}))

	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		t.Fatalf("NewInfra: %v", err)
	}
	defer in.Close()
	// 失败时把收集到的日志打出来：否则只能看到响应，看不到服务端那一刻的原因。
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("服务端日志尾部:\n%s", tail(sink.String(), 4000))
		}
	})

	m, err := newModules(ctx, cfg, in)
	if err != nil {
		t.Fatalf("newModules: %v", err)
	}
	// run 的启动路径就是这一段：自检不过就拒绝启动。
	if err := selfCheck(ctx, m, in); err != nil {
		t.Fatalf("启动自检失败（这正是 run 会拒绝启动的那种错）: %v", err)
	}
	registerTasks(in, m)

	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// run 里的两个后台循环都真跑：worker 消费队列，cron 在启动时入队 queue:cleanup。
	go func() { _ = in.Worker.Run(wctx) }()
	go func() { _ = runCron(wctx, in) }()

	// 前置 1：第一个超管（CLI 路径，auth.Service.CreateAdmin）。
	if err := m.Auth.CreateAdmin(ctx, auth.CreateAdminInput{
		Handle: "root", Email: "root@sc2clud.local", Nickname: "root", Password: "root-password-1",
	}); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	root, err := m.User.BriefByHandle(ctx, "root")
	if err != nil {
		t.Fatalf("读回超管: %v", err)
	}
	super := &authz.Actor{UserID: root.ID, Status: "active", Activated: true, IsSuper: true}

	// 前置 2：一个 provider=log 的发信账号 —— 拍板 §12.6 要的「零外部依赖跑通注册 → 收码 → 激活」。
	// 凭据是空的 {}：log provider 不用它，但 HasUsable 要求凭据能被主密钥解开。
	if _, err := m.Mail.CreateAccount(ctx, super, mail.AccountInput{
		Name: "log-dev", Provider: "log", FromAddress: "noreply@sc2clud.local",
		Secret: json.RawMessage("{\"note\":\"log provider\"}"),
	}); err != nil {
		t.Fatalf("建 log 发信账号: %v", err)
	}
	// 前置 3：一个分区（0017 只播角色与权限，分区是运营数据，迁移里没有）。
	// ON CONFLICT DO NOTHING：同包用例共用一个库，别的用例（Seed）可能已经建过它。
	if _, err := in.Pool.Exec(ctx, "INSERT INTO boards (slug, name, description) VALUES ($1, $2, $3) "+
		"ON CONFLICT (slug) DO NOTHING", "general", "综合", "端到端用例的分区"); err != nil {
		t.Fatalf("建分区: %v", err)
	}

	gin.SetMode(gin.TestMode)
	srv, err := newHTTPServer(cfg, in, m, BuildInfo{Version: "e2e", StartedAt: time.Now().UTC()})
	if err != nil {
		t.Fatalf("newHTTPServer（路由注册在这里发生，重复通配符会 panic）: %v", err)
	}
	ts := httptest.NewServer(srv.Engine)
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	api := &apiClient{t: t, base: ts.URL, c: &http.Client{Jar: jar, Timeout: 20 * time.Second}}

	// ── 0. 探针（验收里的 curl /healthz 200）────────────────────────
	api.mustDo(http.StatusOK, http.MethodGet, "/healthz", "")
	api.mustDo(http.StatusOK, http.MethodGet, "/readyz", "")

	// ── 1. 注册 ───────────────────────────────────────────────────
	api.mustDo(http.StatusCreated, http.MethodPost, "/api/v1/auth/register",
		"{\"username\":\"alice\",\"email\":\"alice@example.com\",\"password\":\"alice-password-1\",\"nickname\":\"爱丽丝\"}")

	// ── 2. 从 mail 的 log provider 读 6 位码（队列 worker 真的把信发出去了）──
	code := waitCode(t, sink)
	t.Logf("从 log provider 读到的验证码: %s", code)

	// ── 3. 激活 ───────────────────────────────────────────────────
	api.mustDo(http.StatusOK, http.MethodPost, "/api/v1/auth/email/verify",
		"{\"username\":\"alice\",\"code\":\""+code+"\"}")

	// ── 4. 登录（会话 Cookie 落进 Cookie 罐）──────────────────────
	api.mustDo(http.StatusOK, http.MethodPost, "/api/v1/auth/login",
		"{\"login\":\"alice\",\"password\":\"alice-password-1\"}")

	// ── 5. 发帖 ───────────────────────────────────────────────────
	// 前置 4：把 alice 标成 trusted。不标的话她的主题是 pending（拍板 §2.2：未受信用户的
	// 内容等审核），公开列表里看不到它 —— 那是产品设计，不是接线问题。
	if _, err := in.Pool.Exec(ctx, "UPDATE users SET trusted = true WHERE username = $1", "alice"); err != nil {
		t.Fatalf("标记 trusted: %v", err)
	}
	created := api.mustDo(http.StatusCreated, http.MethodPost, "/api/v1/topics",
		"{\"board\":\"general\",\"kind\":\"discussion\",\"title\":\"端到端：第一条主题\",\"content_md\":\"正文里有**加粗**与 [链接](https://example.com)。\"}")
	topicID := jsonField(t, created, "data", "id")

	// ── 6. 读列表 ─────────────────────────────────────────────────
	list := api.mustDo(http.StatusOK, http.MethodGet, "/api/v1/topics?board=general", "")
	if !strings.Contains(list, "端到端：第一条主题") {
		t.Fatalf("列表里没有刚发的主题:\n%s", list)
	}

	// ── 7. 进详情 ─────────────────────────────────────────────────
	api.mustDo(http.StatusOK, http.MethodGet, "/api/v1/topics/"+topicID, "")

	// ── 8. 回复：bob 回一条 → forum 的写路径与队列都在转 ──────────────
	// 注意：notify:reply 的任务会被领走并**完成**，但不会产生通知行 —— forum 入队的 payload 是
	// {"id": <post id>}（posts.go:187），而 notify 的处理函数要的是
	// {actor_id, ref_type, ref_id, topic_id}（queue/types.go 的契约，notify/tasks.go:37 按它解）。
	// 解出来的 ref_id=0 → 查不到楼层 → 静默 return nil。这是 producer 与 consumer 的形状不一致，
	// 属于 forum / notify 两个域的问题（已写进回报），本轮写作用域不含它们的 service 逻辑，
	// 所以这里只断言「任务被处理完了」，不假装通知已经发出去。
	registerUser(t, api, sink, "bob", "bob@example.com", "bob-password-1", "鲍勃")
	api.mustDo(http.StatusCreated, http.MethodPost, "/api/v1/topics/"+topicID+"/posts",
		"{\"content_md\":\"回一句，看看任务链路转不转。\"}")
	waitRow(t, ctx, in, "SELECT count(*) FROM jobs WHERE type = 'notify:reply' AND status = 'done'",
		nil, "notify:reply 任务没被处理")

	// ── 9. cron 与图片 GC：启动时入队的 queue:cleanup 跑完，并在里面入队了 image:gc ──
	waitRow(t, ctx, in, "SELECT count(*) FROM jobs WHERE type = 'queue:cleanup' AND status = 'done'",
		nil, "queue:cleanup 没跑完（cron 与清理处理函数）")
	waitRow(t, ctx, in, "SELECT count(*) FROM jobs WHERE type = 'image:gc' AND status = 'done'",
		nil, "image:gc 没跑完（media 的任务处理函数）")

	// ── 10. 异步链路真的走完了 ────────────────────────────────────
	// search:index 的产物：topic_search 里有一行（没注册处理函数的话任务会进 dead，这里就没有行）。
	waitRow(t, ctx, in, "SELECT count(*) FROM topic_search WHERE topic_id = $1",
		[]any{topicInternalID(t, ctx, in, topicID)}, "search:index 没写索引")
	// 没有一个任务进 dead：这就是「全部任务类型都注册了」的证据。
	var dead int
	if err := in.Pool.QueryRow(ctx, "SELECT count(*) FROM jobs WHERE status = 'dead'").Scan(&dead); err != nil {
		t.Fatalf("读 jobs: %v", err)
	}
	if dead != 0 {
		var detail string
		_ = in.Pool.QueryRow(ctx, "SELECT string_agg(type || ': ' || last_error, '; ') FROM jobs WHERE status = 'dead'").Scan(&detail)
		t.Fatalf("有 %d 个任务进了 dead（说明有任务类型没注册或处理函数报错）: %s", dead, detail)
	}
	t.Logf("队列里没有 dead 任务；log provider 日志片段：\n%s", tail(sink.String(), 1200))

	// ── 11. 每个域至少一条读路由都通（bob 的会话）────────────────────
	// 这一段的用途：证明「路由挂上了，而且挂上去时依赖不是 nil」。
	// 只挂路由不接依赖的话，这些读请求会 500 或 panic —— 那是本轮最容易犯的错。
	for _, path := range []string{
		"/api/v1/me",                   // auth
		"/api/v1/users/alice",          // user 个人主页（头像 URL 走 media 的拼接点）
		"/api/v1/users/search?q=alice", // user 前缀候选
		"/api/v1/boards",               // forum 分区列表
		"/api/v1/boards/general",       // forum 分区详情
		// 【发现的缺陷】/api/v1/issues（全站聚合、不带筛选）在这个库上 500：SQLSTATE 42P18
		// 「无法确定参数 $5 的数据类型」—— forum/pgsql/issues.go:148 只在 TopicID>0 时把 $5 拼进
		// SQL，而 args 里始终有它（pgx 走 DescribeExec，未被引用的 $5 定不出类型）。一行可修
		// （scope 改成 "($5::bigint IS NULL OR i.topic_id = $5)"），但那是 forum 域的 SQL，
		// 不在本轮写作用域内。所以这里冒烟的是单帖 issue 列表。
		"/api/v1/topics/" + topicID + "/issues", // forum 单帖 issue 列表
		"/api/v1/me/bookmarks",                  // forum 收藏（要登录）
		"/api/v1/titles",                        // title 目录
		"/api/v1/users/alice/titles",            // title 某人持有的头衔
		"/api/v1/site",                          // site 首页聚合
		"/api/v1/notifications",                 // notify 收件箱
		"/api/v1/notifications/unread-count",
		"/api/v1/messages",              // message 会话列表
		"/api/v1/messages/unread-count", // message 角标
		"/api/v1/me/reports",            // report 我的举报
		"/api/v1/me/rewards",            // reward 我的申报
		"/api/v1/me/donation-settings",  // reward 收款设置
		"/api/v1/users/alice/channels",  // reward 别人的收款码
		"/api/v1/users/alice/rewards",   // reward 别人的赞赏记录
		"/api/v1/launcher/releases",     // release 版本列表
		"/api/v1/launcher/latest",       // release 最新版（没有发布过时 404，也是通的）
	} {
		status, raw := api.do(http.MethodGet, path, "")
		if status >= 500 {
			t.Fatalf("%s 返回 %d（路由挂上了但依赖没接对）:\n%s", path, status, raw)
		}
	}

	// ── 12. 限流中间件真的在挡（report:create = 10 次/小时，d6 §5.6 第 5 条）──
	// 额度表在 modules.go 的 endpointLimits；这条断言把「接上了但没生效」也堵住。
	// 前 10 次的 handler 也会跑（幂等：同一目标只留一条举报），第 11 次在中间件就被挡下。
	reportBody := "{\"target_type\":\"topic\",\"target_id\":\"" + topicID + "\",\"reason\":\"spam\",\"detail\":\"\"}"
	for i := 1; i <= 10; i++ {
		if status, raw := api.do(http.MethodPost, "/api/v1/reports", reportBody); status >= 500 {
			t.Fatalf("第 %d 次举报 500（report 的目标解析适配器没接对）:\n%s", i, raw)
		}
	}
	status, raw := api.do(http.MethodPost, "/api/v1/reports", reportBody)
	if status != http.StatusTooManyRequests {
		t.Fatalf("第 11 次举报应当被限流成 429，实际 %d:\n%s", status, raw)
	}
}

// registerUser 走一遍「注册 → 从日志取码 → 激活 → 登录」，第二个用户要用它。
func registerUser(t *testing.T, api *apiClient, sink *logSink, username, email, password, nickname string) {
	t.Helper()
	api.mustDo(http.StatusCreated, http.MethodPost, "/api/v1/auth/register",
		"{\"username\":\""+username+"\",\"email\":\""+email+"\",\"password\":\""+password+"\",\"nickname\":\""+nickname+"\"}")
	code := waitCode(t, sink)
	api.mustDo(http.StatusOK, http.MethodPost, "/api/v1/auth/email/verify",
		"{\"username\":\""+username+"\",\"code\":\""+code+"\"}")
	api.mustDo(http.StatusOK, http.MethodPost, "/api/v1/auth/login",
		"{\"login\":\""+username+"\",\"password\":\""+password+"\"}")
}

func userInternalID(t *testing.T, ctx context.Context, in *Infra, username string) int64 {
	t.Helper()
	var id int64
	if err := in.Pool.QueryRow(ctx, "SELECT id FROM users WHERE username = $1", username).Scan(&id); err != nil {
		t.Fatalf("读用户内部 id: %v", err)
	}
	return id
}

// e2eConfig 是端到端用例的配置：真库 + 内存 KV + 临时图片目录 + log 发信。
func e2eConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg := config.Default()
	cfg.Env = "dev"
	cfg.DB.DSN = testsupport.DSN()
	cfg.DB.MaxConns, cfg.DB.MinConns = 8, 1
	cfg.Image.Root = t.TempDir()
	cfg.Mail.KeyHex = strings.Repeat("ab", 32)
	cfg.Site.BaseURL = "http://127.0.0.1:8081"
	cfg.Captcha.Mode = "off"
	cfg.Web.ServeShell, cfg.Web.ServeAssets = false, false
	cfg.HTTP.TrustedProxies = nil
	// 队列快一点：默认 1 秒轮询会让这个用例白等
	cfg.Queue.PollInterval = 50 * time.Millisecond
	cfg.Queue.BackoffBase = 50 * time.Millisecond
	cfg.Queue.BackoffCap = time.Second
	cfg.Queue.Workers = 2
	auto := true
	cfg.Auth.AutoActivate = &auto
	return cfg
}

func waitCode(t *testing.T, sink *logSink) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if code, ok := sink.takeCode(codeRe); ok {
			return code
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("20 秒内没等到 log provider 的验证码；日志尾部：\n%s", tail(sink.String(), 2000))
	return ""
}

// waitRow 等一行计数变成非零（异步任务的结果不会立刻出现）。
func waitRow(t *testing.T, ctx context.Context, in *Infra, query string, args []any, what string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		if err := in.Pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
			t.Fatalf("查询失败: %v", err)
		}
		if n > 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("20 秒内没等到：%s", what)
}

func topicInternalID(t *testing.T, ctx context.Context, in *Infra, publicID string) int64 {
	t.Helper()
	var id int64
	if err := in.Pool.QueryRow(ctx, "SELECT id FROM topics WHERE public_id = $1::uuid", publicID).Scan(&id); err != nil {
		t.Fatalf("按 public_id 读主题内部 id: %v", err)
	}
	return id
}

// jsonField 取 data.<field> 这种响应字段（足够这个用例用，不引第三方断言库）。
func jsonField(t *testing.T, raw string, path ...string) string {
	t.Helper()
	var cur any
	if err := json.Unmarshal([]byte(raw), &cur); err != nil {
		t.Fatalf("响应不是 JSON: %v\n%s", err, raw)
	}
	for _, key := range path {
		obj, ok := cur.(map[string]any)
		if !ok {
			t.Fatalf("响应缺少 %q:\n%s", strings.Join(path, "."), raw)
		}
		cur, ok = obj[key]
		if !ok {
			t.Fatalf("响应缺少 %q:\n%s", strings.Join(path, "."), raw)
		}
	}
	return strings.Trim(strings.TrimSpace(toJSON(cur)), "\"")
}

func toJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
