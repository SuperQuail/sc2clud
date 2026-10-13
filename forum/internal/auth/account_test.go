package auth

import (
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/queue"
)

// errCode 断言错误码而不是文案：错误码是前后端唯一约定（拍板 §5.2）。
func errCode(err error) string {
	var ae *apperr.Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

func (f *fixture) register(username, password string) *RegisterResult {
	f.t.Helper()
	out, err := f.svc.Register(f.ctx, RegisterInput{
		Username: username, Email: username + "@example.com", Password: password, IP: "127.0.0.1",
	})
	if err != nil {
		f.t.Fatalf("注册失败: %v", err)
	}
	return out
}

// 用例 31 + 拍板 §9.2：注册成功、**不建会话**、落一条 verify 码、投一条 mail:send。
func TestRegisterCreatesAccountWithoutSession(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	out := f.register("tangtian", "passw0rd-1")

	if out.ActivationPending != PendingEmail {
		t.Fatalf("activation_pending = %q，有可用发信账号时应当走邮件路", out.ActivationPending)
	}
	if out.EmailVerified {
		t.Fatal("刚注册就 email_verified=true")
	}
	var sessions int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM sessions").Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 {
		t.Fatalf("注册建了 %d 条会话，设计 §7.1 要求不自动登录", sessions)
	}

	var purpose string
	var expires time.Time
	if err := f.pool.QueryRow(f.ctx, "SELECT purpose, expires_at FROM email_tokens WHERE used_at IS NULL").Scan(&purpose, &expires); err != nil {
		t.Fatal(err)
	}
	if purpose != purposeVerify {
		t.Fatalf("purpose = %q", purpose)
	}
	if got := expires.Sub(f.clk.Now()); got != codeTTL {
		t.Fatalf("有效期 %v，想要 %v（拍板 §11.4：10 分钟）", got, codeTTL)
	}
	if f.queue.count() != 1 {
		t.Fatalf("入队 %d 条任务，想要 1 条 mail:send", f.queue.count())
	}
	if f.queue.tasks[0].Type != queue.TypeMailSend {
		t.Fatalf("任务类型 = %q", f.queue.tasks[0].Type)
	}

	var hash []byte
	if err := f.pool.QueryRow(f.ctx, "SELECT token_hash FROM email_tokens WHERE used_at IS NULL").Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if string(hash) == f.sent.get(t) {
		t.Fatal("库里存了明文验证码")
	}
	if len(hash) != 32 {
		t.Fatalf("token_hash 长度 %d，想要 32（sha256）", len(hash))
	}
}

// 用例 32/33：大小写重名走唯一索引（证明 lower() 索引真的生效），两个码分得开。
func TestRegisterDuplicateUsernameAndEmail(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.register("TangTian", "passw0rd-1")

	_, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "tangtian", Email: "other@example.com", Password: "passw0rd-1", IP: "127.0.0.1",
	})
	if errCode(err) != "auth.handle_taken" {
		t.Fatalf("大小写重名 -> %v（code=%q），想要 auth.handle_taken", err, errCode(err))
	}

	_, err = f.svc.Register(f.ctx, RegisterInput{
		Username: "other", Email: "TANGTIAN@example.com", Password: "passw0rd-1", IP: "127.0.0.1",
	})
	if errCode(err) != "auth.email_taken" {
		t.Fatalf("邮箱大小写重复 -> %v（code=%q），想要 auth.email_taken", err, errCode(err))
	}
}

// 用例 34：口令规则的边界（信任边界上的校验，都在 service 里）。
func TestRegisterPasswordRules(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	bad := map[string]string{
		"too-short": "1234567",
		"blank":     "        ",
		"too-long":  strings.Repeat("a", 129),
	}
	for name, pw := range bad {
		_, err := f.svc.Register(f.ctx, RegisterInput{
			Username: "u" + name, Email: "u@example.com", Password: pw, IP: "127.0.0.1",
		})
		if errCode(err) != apperr.CodeInvalidInput {
			t.Fatalf("%s: %v（code=%q），想要 %s", name, err, errCode(err), apperr.CodeInvalidInput)
		}
	}
}

// 用例 44 + 拍板 §9.2/§9.5：一个发信账号都没有 → manual、**不入队**、注册仍然成功。
func TestRegisterWithoutMailAccountsGoesManual(t *testing.T) {
	f := newFixture(t, func(d *Deps) { d.Mail = noMailAccounts{} })
	f.seedRBAC()
	out := f.register("nomail", "passw0rd-1")
	if out.ActivationPending != PendingManual {
		t.Fatalf("activation_pending = %q，想要 manual", out.ActivationPending)
	}
	if f.queue.count() != 0 {
		t.Fatalf("没有可用账号却入了 %d 条任务（拍板 §9.2：这种情况不入队、不重试）", f.queue.count())
	}
	var tokens int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM email_tokens").Scan(&tokens); err != nil {
		t.Fatal(err)
	}
	if tokens != 0 {
		t.Fatalf("没有发信能力却写了 %d 条验证码", tokens)
	}
}

// 用例 35：登录失败不区分原因，**同一个码**。
func TestLoginFailureIsIndistinguishable(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("alice", "passw0rd-1", "user")

	_, errWrongPw := f.svc.Login(f.ctx, LoginInput{Login: "alice", Password: "wrong-pass-1", IP: "127.0.0.1"})
	_, errNoUser := f.svc.Login(f.ctx, LoginInput{Login: "nobody", Password: "wrong-pass-1", IP: "127.0.0.1"})
	if errCode(errWrongPw) != "auth.bad_credentials" || errCode(errNoUser) != "auth.bad_credentials" {
		t.Fatalf("两种失败的码不同：%q / %q", errCode(errWrongPw), errCode(errNoUser))
	}
}

// 用例 38 + 拍板 §9.12：**未激活可以登录**，只是 Activated=false。
func TestInactiveUserCanLogin(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUserRow("inactive", "passw0rd-1", "user", false)

	tok := f.login("inactive", "passw0rd-1")
	actor := f.actor(tok)
	if actor.Activated {
		t.Fatal("activated_at 为 NULL 却 Activated=true")
	}
	if actor.Status != StatusActive {
		t.Fatalf("status = %q", actor.Status)
	}

	me, err := f.svc.Me(f.ctx, actor)
	if err != nil {
		t.Fatal(err)
	}
	if me.Activated || me.ActivationPending != "" {
		t.Fatalf("me.Activated=%v activation_pending=%q", me.Activated, me.ActivationPending)
	}
}

// 用例 21 + 设计 §6.6：封号后**同一个 cookie 的下一个请求**就失效，不等任何 TTL；
// 而会话行**不删**，所以解封后同一个 cookie 又能用。
func TestBanInvalidatesSessionImmediately(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("bob", "passw0rd-1", "user")
	tok := f.login("bob", "passw0rd-1")
	if _, err := f.svc.Resolve(f.ctx, tok); err != nil {
		t.Fatalf("封号前解析失败: %v", err)
	}

	admin := f.newSuperAdmin("root")
	var pub string
	if err := f.pool.QueryRow(f.ctx, "SELECT public_id FROM users WHERE username = 'bob'").Scan(&pub); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.BanUser(f.ctx, admin, BanInput{UserPublicID: pub, Action: "ban", IP: "127.0.0.1"}); err != nil {
		t.Fatalf("封号失败: %v", err)
	}
	if _, err := f.svc.Resolve(f.ctx, tok); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("封号后解析 -> %v，想要 ErrSessionInvalid", err)
	}
	var n int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 'bob'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("封号后会话行数 = %d，设计 §6.6 要求保留", n)
	}
	if _, err := f.svc.BanUser(f.ctx, admin, BanInput{UserPublicID: pub, Action: "unban", IP: "127.0.0.1"}); err != nil {
		t.Fatalf("解封失败: %v", err)
	}
	if _, err := f.svc.Resolve(f.ctx, tok); err != nil {
		t.Fatalf("解封后解析失败: %v", err)
	}
}

// 用例 18：伪造 / 过期 token 都是 ErrSessionInvalid（调用方当游客 + 清 Cookie）。
func TestResolveRejectsForgedAndExpired(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("carol", "passw0rd-1", "user")
	tok := f.login("carol", "passw0rd-1")

	if _, err := f.svc.Resolve(f.ctx, "not-a-real-token"); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("伪造 token -> %v", err)
	}
	f.clk.T = f.clk.T.Add(721 * time.Hour)
	if _, err := f.svc.Resolve(f.ctx, tok); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("过期 token -> %v（过期判定必须走 clock，方案 §14.7）", err)
	}
}

// 用例 29/30：会话列表只列自己的、is_current 正确、踢别人的 404、踢自己的生效。
func TestSessionListAndRevoke(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("dave", "passw0rd-1", "user")
	f.newUser("erin", "passw0rd-1", "user")
	tokD := f.login("dave", "passw0rd-1")
	tokD2 := f.login("dave", "passw0rd-1")
	tokE := f.login("erin", "passw0rd-1")

	dave := f.actor(tokD)
	pd, _ := f.svc.Resolve(f.ctx, tokD)
	items, err := f.svc.ListSessions(f.ctx, dave, pd.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("dave 有 %d 条会话，想要 2", len(items))
	}
	current := 0
	for _, it := range items {
		if it.IsCurrent {
			current++
		}
		if it.ID == "" || strings.ContainsAny(it.ID, "+/=") {
			t.Fatalf("会话 id 形状不对（应当是 base64url 无填充）: %q", it.ID)
		}
	}
	if current != 1 {
		t.Fatalf("is_current 命中 %d 条，想要 1", current)
	}

	pe, _ := f.svc.Resolve(f.ctx, tokE)
	if err := f.svc.RevokeSession(f.ctx, dave, sessionKey(pe.Digest)); !errors.Is(err, errSessionNotFound) {
		t.Fatalf("踢别人的会话 -> %v，想要 errSessionNotFound", err)
	}
	if _, err := f.svc.Resolve(f.ctx, tokE); err != nil {
		t.Fatalf("erin 的会话被误删: %v", err)
	}

	pd2, _ := f.svc.Resolve(f.ctx, tokD2)
	if err := f.svc.RevokeSession(f.ctx, dave, sessionKey(pd2.Digest)); err != nil {
		t.Fatalf("踢自己的会话失败: %v", err)
	}
	if _, err := f.svc.Resolve(f.ctx, tokD2); !errors.Is(err, ErrSessionInvalid) {
		t.Fatal("被踢的会话仍然有效")
	}
	if _, err := f.svc.Resolve(f.ctx, tokD); err != nil {
		t.Fatalf("当前会话被误删: %v", err)
	}
}

// 用例 50：改密码后同 cookie 立刻失效，新旧口令的登录结果相反。
func TestChangePasswordRevokesAllSessions(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("frank", "passw0rd-1", "user")
	tok := f.login("frank", "passw0rd-1")
	actor := f.actor(tok)

	if err := f.svc.ChangePassword(f.ctx, actor, ChangePasswordInput{
		OldPassword: "passw0rd-1", NewPassword: "passw0rd-2", IP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("改密码失败: %v", err)
	}
	if _, err := f.svc.Resolve(f.ctx, tok); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("改密码后旧 cookie 仍有效: %v", err)
	}
	if _, err := f.svc.Login(f.ctx, LoginInput{Login: "frank", Password: "passw0rd-1", IP: "127.0.0.1"}); errCode(err) != "auth.bad_credentials" {
		t.Fatalf("旧口令还能登录: %v", err)
	}
	if _, err := f.svc.Login(f.ctx, LoginInput{Login: "frank", Password: "passw0rd-2", IP: "127.0.0.1"}); err != nil {
		t.Fatalf("新口令登录失败: %v", err)
	}
}

// 用例 51：新密码与旧密码相同 → 400，fields 指向 new_password。
func TestChangePasswordRejectsSamePassword(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("grace", "passw0rd-1", "user")
	actor := f.actor(f.login("grace", "passw0rd-1"))

	err := f.svc.ChangePassword(f.ctx, actor, ChangePasswordInput{
		OldPassword: "passw0rd-1", NewPassword: "passw0rd-1", IP: "127.0.0.1",
	})
	if errCode(err) != apperr.CodeInvalidInput {
		t.Fatalf("同密码 -> %v（code=%q）", err, errCode(err))
	}
	var ae *apperr.Error
	if errors.As(err, &ae) {
		if _, ok := ae.Fields["new_password"]; !ok {
			t.Fatalf("fields 没有指向 new_password: %v", ae.Fields)
		}
	}
}

// 用例 37：明文口令不进日志。
func TestPasswordNeverLogged(t *testing.T) {
	var buf strings.Builder
	f := newFixture(t, func(d *Deps) {
		d.Log = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	f.seedRBAC()
	f.register("leaky", "sup3r-secret-pw")
	f.newUser("hunter", "sup3r-secret-pw", "user")
	f.login("hunter", "sup3r-secret-pw")
	_, _ = f.svc.Login(f.ctx, LoginInput{Login: "hunter", Password: "wrong-pw-12345", IP: "127.0.0.1"})
	if strings.Contains(buf.String(), "sup3r-secret-pw") || strings.Contains(buf.String(), "wrong-pw-12345") {
		t.Fatalf("日志里出现了明文口令:\n%s", buf.String())
	}
}

// 限流接上了：被拒时是 429 auth.too_many_requests（不是 500、不是放行）。
func TestLoginRateLimited(t *testing.T) {
	f := newFixture(t, func(d *Deps) { d.Limiter = denyAll{} })
	f.seedRBAC()
	f.newUser("limited", "passw0rd-1", "user")
	_, err := f.svc.Login(f.ctx, LoginInput{Login: "limited", Password: "passw0rd-1", IP: "127.0.0.1"})
	if errCode(err) != "auth.too_many_requests" {
		t.Fatalf("被限流时 -> %v（code=%q）", err, errCode(err))
	}
}

// newSuperAdmin 走 create-admin（CLI 路径）造一个可用超管。
func (f *fixture) newSuperAdmin(name string) *authz.Actor {
	f.t.Helper()
	if err := f.svc.CreateAdmin(f.ctx, CreateAdminInput{
		Handle: name, Email: name + "@example.com", Nickname: name, Password: "passw0rd-1",
	}); err != nil {
		f.t.Fatalf("create-admin 失败: %v", err)
	}
	return f.actor(f.login(name, "passw0rd-1"))
}
