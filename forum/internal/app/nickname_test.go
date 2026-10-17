package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/auth"
	"forum/internal/authz"
	"forum/internal/mail"
	"forum/internal/platform/db"
	"forum/migrations"
)

// harness 起一个独立的 HTTP 实例（与 TestEndToEndMainChain 同一套装配），
// 这样昵称的几条断言走的是**真的路由与真的 JSON 字段名**，不是 service 内部调用。
type harness struct {
	t    *testing.T
	ctx  context.Context
	in   *Infra
	api  *apiClient
	sink *logSink
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	if testing.Short() {
		t.Skip("端到端用例要起真库，-short 跳过")
	}
	ctx := context.Background()
	cfg := e2eConfig(t)
	if err := db.Migrate(ctx, cfg.DB.DSN, migrations.FS()); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}
	sink := &logSink{}
	log := slog.New(slog.NewTextHandler(sink, &slog.HandlerOptions{Level: slog.LevelInfo}))
	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		t.Fatalf("NewInfra: %v", err)
	}
	t.Cleanup(in.Close)
	m, err := newModules(ctx, cfg, in)
	if err != nil {
		t.Fatalf("newModules: %v", err)
	}
	if err := selfCheck(ctx, m, in); err != nil {
		t.Fatalf("启动自检失败: %v", err)
	}
	registerTasks(in, m)
	wctx, cancel := context.WithCancel(ctx)
	t.Cleanup(cancel)
	go func() { _ = in.Worker.Run(wctx) }()

	// 超管与发信账号是**进程级共享**的（同一个真库），已经有人建过就复用：
	// 再建一次会撞 uq_users_username_lower（auth.handle_taken），那不是被测行为。
	root, err := m.User.BriefByHandle(ctx, "root")
	if err != nil {
		if err := m.Auth.CreateAdmin(ctx, auth.CreateAdminInput{
			Handle: "root", Email: "root@sc2clud.local", Nickname: "root", Password: "root-password-1",
		}); err != nil {
			t.Fatalf("CreateAdmin: %v", err)
		}
		if root, err = m.User.BriefByHandle(ctx, "root"); err != nil {
			t.Fatalf("读回超管: %v", err)
		}
	}
	super := &authz.Actor{UserID: root.ID, Status: "active", Activated: true, IsSuper: true}
	// 账号名加时间戳：真库是共享的，固定名字在同一次 go test 的第二个用例里会撞唯一索引
	// （那不是被测行为）。发信账号本身也是共享状态，重名复用比「先删再建」少一个破坏性动作。
	if _, err := m.Mail.CreateAccount(ctx, super, mail.AccountInput{
		Name: "log-dev-" + strconv.FormatInt(time.Now().UnixNano(), 36), Provider: "log",
		FromAddress: "noreply@sc2clud.local",
		Secret:      json.RawMessage(`{"note":"log provider"}`),
	}); err != nil {
		t.Fatalf("建 log 发信账号: %v", err)
	}

	gin.SetMode(gin.TestMode)
	srv, err := newHTTPServer(cfg, in, m, BuildInfo{Version: "nick", StartedAt: time.Now().UTC()})
	if err != nil {
		t.Fatalf("newHTTPServer: %v", err)
	}
	ts := httptest.NewServer(srv.Engine)
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return &harness{t: t, ctx: ctx, in: in, sink: sink,
		api: &apiClient{t: t, base: ts.URL, c: &http.Client{Jar: jar, Timeout: 20 * time.Second}}}
}

// register 走「注册 → 从 log provider 取码 → 激活 → 登录」，nickname 可以为空串。
func (h *harness) register(username, email, password, nickname string) {
	h.t.Helper()
	h.api.mustDo(http.StatusCreated, http.MethodPost, "/api/v1/auth/register",
		toJSON(map[string]string{"username": username, "email": email, "password": password, "nickname": nickname}))
	code := waitCode(h.t, h.sink)
	h.api.mustDo(http.StatusOK, http.MethodPost, "/api/v1/auth/email/verify",
		toJSON(map[string]string{"username": username, "code": code}))
	h.api.mustDo(http.StatusOK, http.MethodPost, "/api/v1/auth/login",
		toJSON(map[string]string{"login": username, "password": password}))
}

// getJSON 取 data 段（GET /me 的形状）。
func (h *harness) getJSON(path string) map[string]any {
	h.t.Helper()
	raw := h.api.mustDo(http.StatusOK, http.MethodGet, path, "")
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		h.t.Fatalf("响应不是 JSON: %v\n%s", err, raw)
	}
	return env.Data
}

func (h *harness) patch(path, body string) (int, string) {
	h.t.Helper()
	return h.api.do(http.MethodPatch, path, body)
}

func (h *harness) patchJSON(path, body string, want int) string {
	h.t.Helper()
	code, raw := h.patch(path, body)
	if code != want {
		h.t.Fatalf("PATCH %s: 期望 %d，实际 %d\n%s", path, want, code, raw)
	}
	return raw
}

// 显示名（昵称）与登录名是两个语义：注册时给两个不同的值，GET /me 必须显示昵称；
// PATCH /me 能改昵称；用户名**改不动**（注册后不可改）。
//
// 端到端而不是只在 service 里测：这几条都要过 HTTP 的字段名（nickname / username），
// 而 JSON 名字写错正是「service 绿、真站红」的那类缺陷。
func TestNicknameIsIndependentFromUsername(t *testing.T) {
	h := newHarness(t)
	user, mail, pass := "nickname-e2e", "nickname-e2e@example.com", "nickname-password-1"

	h.register(user, mail, pass, "显示名甲")

	var stored string
	if err := h.in.Pool.QueryRow(h.ctx, "SELECT nickname FROM users WHERE username = $1", user).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "显示名甲" {
		t.Fatalf("注册后库里的 nickname = %q，想要 显示名甲", stored)
	}

	me := h.getJSON("/api/v1/me")
	if me["nickname"] != "显示名甲" {
		t.Fatalf("GET /me 的 nickname = %v，想要 显示名甲（用户名是 %s）", me["nickname"], user)
	}
	if me["handle"] != user {
		t.Fatalf("GET /me 的 handle = %v，想要 %s", me["handle"], user)
	}

	// 改昵称：真的变了
	h.patchJSON("/api/v1/me", `{"nickname":"显示名乙"}`, http.StatusOK)
	if me = h.getJSON("/api/v1/me"); me["nickname"] != "显示名乙" {
		t.Fatalf("PATCH 之后 nickname = %v，想要 显示名乙", me["nickname"])
	}

	// 改用户名：**不接受**。已知：现在返回 200 但是空操作（{} 是合法 body，handler 不判字段），
	// 所以这里断言的是「登录名没变、昵称也没被顺手清掉」，而不是某个具体状态码。
	// 这条空操作本身是缺陷（客户端会以为改成功了），见回报；修它要改 handler 的语义，不在本轮范围。
	if code, _ := h.patch("/api/v1/me", `{"username":"hacked-name"}`); code >= http.StatusInternalServerError {
		t.Fatalf("PATCH /me 带 username 返回 %d（500）", code)
	}
	h.patchJSON("/api/v1/me", `{"nickname":"显示名丙"}`, http.StatusOK)
	var username string
	if err := h.in.Pool.QueryRow(h.ctx, "SELECT username FROM users WHERE username = $1", user).Scan(&username); err != nil {
		t.Fatalf("登录名被改掉了（查不到 %s）: %v", user, err)
	}
	// 实实在在读一次库里那一行：handle 没变、昵称是刚才设的值
	me = h.getJSON("/api/v1/me")
	if me["handle"] != user {
		t.Fatalf("改用户名之后 handle = %v，想要 %s", me["handle"], user)
	}
	if me["nickname"] != "显示名丙" {
		t.Fatalf("改用户名的请求动了昵称：nickname = %v", me["nickname"])
	}
}

// 2026-10-16 用户报 request_id c3961890d12c3a1a：昵称 7 个汉字（7 字符 / 21 字节）注册 500。
// 根因是 ent 的 field.String().MaxLen 按**字节**校验，而 users.nickname 是 varchar(20)、
// 服务层也按 **rune** —— 中文一到 7 个字就被 ent 挡下。
//
// 这条在 **HTTP 层**把三个点钉住（service 层那条同款在 auth/nickname_runes_test.go）：
// 7 个汉字能注册并原样落库；21 个汉字是**字段级 400**（不是 500）。
func TestNicknameLengthCountsRunesOverHTTP(t *testing.T) {
	h := newHarness(t)
	seven := strings.Repeat("好", 7)
	user := "nick-rune-7"
	h.register(user, user+"@example.com", "nickname-password-1", seven)

	var stored string
	if err := h.in.Pool.QueryRow(h.ctx, "SELECT nickname FROM users WHERE username = $1", user).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != seven {
		t.Fatalf("落库昵称 = %q，想要 %q（7 个汉字 = 7 字符，远在 20 之内）", stored, seven)
	}

	code, raw := h.api.do(http.MethodPost, "/api/v1/auth/register", toJSON(map[string]string{
		"username": "nick-rune-21", "email": "nick-rune-21@example.com",
		"password": "nickname-password-1", "nickname": strings.Repeat("好", 21),
	}))
	if code != http.StatusBadRequest {
		t.Fatalf("21 个汉字应当 400（字段级），实际 %d：%s", code, raw)
	}
}

// 昵称留空 = 没设显示名：库里存空串，**不回填**成 username；显示时回落到登录名。
// 这一条挡的是「留空被写死成用户名」——那样之后再改昵称，历史语义就全是错的。
func TestBlankNicknameFallsBackWithoutWritingBack(t *testing.T) {
	h := newHarness(t)
	user, mail, pass := "blank-nick", "blank-nick@example.com", "blank-nick-password-1"

	h.register(user, mail, pass, "")

	var stored string
	if err := h.in.Pool.QueryRow(h.ctx, "SELECT nickname FROM users WHERE username = $1", user).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "" {
		t.Fatalf("留空昵称被回填成 %q；昵称与用户名不该强制同步", stored)
	}

	me := h.getJSON("/api/v1/me")
	if me["nickname"] != user {
		t.Fatalf("留空时 GET /me 的 nickname = %v，想要回落到登录名 %s", me["nickname"], user)
	}
	// 再查一次：回落只发生在响应里，不写回
	if again := h.getJSON("/api/v1/me"); again["nickname"] != user {
		t.Fatalf("第二次查询 nickname = %v", again["nickname"])
	}
	if err := h.in.Pool.QueryRow(h.ctx, "SELECT nickname FROM users WHERE username = $1", user).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "" {
		t.Fatalf("查询把 nickname 写成了 %q", stored)
	}

	// PATCH 一个空串：拒绝（那等于「删掉显示名」，语义含糊，先不做）
	if code, _ := h.patch("/api/v1/me", `{"nickname":"   "}`); code != http.StatusBadRequest {
		t.Fatalf("PATCH 空昵称返回 %d，想要 400", code)
	}
}
