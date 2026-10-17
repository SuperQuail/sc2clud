package auth

import (
	"errors"
	"testing"
	"time"

	"forum/internal/platform/apperr"
)

// codeRow 读当前活跃的验证码行（token_hash / expires_at / used_at）。
func (f *fixture) liveToken(purpose string) (hash []byte, expires time.Time, used *time.Time) {
	f.t.Helper()
	err := f.pool.QueryRow(f.ctx,
		"SELECT token_hash, expires_at, used_at FROM email_tokens WHERE purpose = $1 AND used_at IS NULL",
		purpose).Scan(&hash, &expires, &used)
	if err != nil {
		f.t.Fatalf("取活跃令牌失败: %v", err)
	}
	return
}

// 非法输入：验证码长度不对、username/email 都没给。
func TestVerifyCodeRejectsBadInput(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.register("vinput", "passw0rd-1")
	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "vinput", Code: "12345"}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("5 位码 -> %v", err)
	}
	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "", Code: "123456"}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("空账号 -> %v", err)
	}
	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "no-such-user", Code: "123456"}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("不存在的账号 -> %v（必须与「码错」同一个码，拍板 §11.4）", err)
	}
}

// 用例 39 + 拍板 §11.2：正确码 → email_verified_at 与 activated_at 都非空、pending 清空、码作废。
func TestVerifyEmailCodeActivatesAccount(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.register("activate-me", "passw0rd-1")
	code := f.sent.get(t)

	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "activate-me", Code: code, IP: "127.0.0.1"}); err != nil {
		t.Fatalf("校验失败: %v", err)
	}
	var verified, activated *time.Time
	if err := f.pool.QueryRow(f.ctx,
		"SELECT email_verified_at, activated_at FROM users WHERE username = 'activate-me'").
		Scan(&verified, &activated); err != nil {
		t.Fatal(err)
	}
	if verified == nil || activated == nil {
		t.Fatalf("激活失败：verified=%v activated=%v（拍板 §12.2：输码成功时两根轴一起置）", verified, activated)
	}
	// 码已被消费：第二次同一个码失败（拍板 §11.8）。
	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "activate-me", Code: code}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("同一个码用第二次 -> %v", err)
	}

	// 拍板 §9.8 第 2 条：激活后写操作才放行（这里只验状态轴，写闸门是中间件的事）。
	actor := f.actor(f.login("activate-me", "passw0rd-1"))
	if !actor.Activated || !actor.EmailVerified {
		t.Fatalf("actor.Activated=%v EmailVerified=%v", actor.Activated, actor.EmailVerified)
	}

	// 审计与业务同事务：一行 auth.email.verify。
	var n int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM audit_logs WHERE action = 'auth.email.verify'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("auth.email.verify 审计 %d 条，想要 1", n)
	}
}

// 用例 40 + 拍板 §11.8 第 3 条：错 5 次即作废，第 6 次即使输对也失败。
func TestVerifyEmailCodeFiveFailuresDestroyCode(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.register("brute", "passw0rd-1")
	code := f.sent.get(t)
	wrong := "000000"
	if wrong == code {
		wrong = "111111"
	}

	for i := 1; i <= maxCodeAttempts; i++ {
		err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "brute", Code: wrong})
		if !errors.Is(err, ErrTokenInvalid) {
			t.Fatalf("第 %d 次错码 -> %v", i, err)
		}
	}
	// 该码已被作废：正确码也不再有效。
	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "brute", Code: code}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("第 5 次失败后正确码仍然有效（拍板 §11.8 第 3 条要求作废）: %v", err)
	}
	var live int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM email_tokens WHERE used_at IS NULL").Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != 0 {
		t.Fatalf("作废后还剩 %d 条活跃码", live)
	}
}

// 用例 41 + 拍板 §11.4：过期与错码**同一个错误码、同一句文案**（文案在 ErrTokenInvalid 上，只有一处）。
func TestVerifyEmailCodeExpiredUsesSameError(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.register("expired", "passw0rd-1")
	code := f.sent.get(t)

	// 10 分钟有效期（拍板 §11.4）：前进 11 分钟即过期。
	f.clk.T = f.clk.T.Add(11 * time.Minute)
	err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "expired", Code: code})
	if !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("过期码 -> %v，想要 ErrTokenInvalid", err)
	}
	// 过期**不**消耗尝试次数：先证明它还能被正确码之外的东西拒掉，再断言状态未变。
	var verified *time.Time
	if err := f.pool.QueryRow(f.ctx, "SELECT email_verified_at FROM users WHERE username = 'expired'").Scan(&verified); err != nil {
		t.Fatal(err)
	}
	if verified != nil {
		t.Fatal("过期码居然激活了账号")
	}
}

// 用例 42 + 拍板 §11.8 第 4 条：重发后旧码立刻失效、新码可用、库里有且只有一条活跃码。
func TestResendInvalidatesOldCode(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.register("resender", "passw0rd-1")
	old := f.sent.get(t)

	actor := f.actor(f.login("resender", "passw0rd-1"))
	// 先记 3 次失败：重发必须把计数清零，否则用户重发一次仍然只剩 2 次机会。
	f.svc.noteBadCodeForTest(actor.UserID, purposeVerify)
	f.svc.noteBadCodeForTest(actor.UserID, purposeVerify)
	f.svc.noteBadCodeForTest(actor.UserID, purposeVerify)

	out, err := f.svc.ResendVerify(f.ctx, actor, "127.0.0.1")
	if err != nil {
		t.Fatalf("重发失败: %v", err)
	}
	if !out.Sent {
		t.Fatal("重发没有投出去")
	}
	newCode := f.sent.get(t)
	if newCode == old {
		t.Fatal("重发没有生成新码")
	}
	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "resender", Code: old}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("旧码重发后仍然有效（拍板 §11.8 第 4 条）: %v", err)
	}
	var live int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM email_tokens WHERE used_at IS NULL").Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != 1 {
		t.Fatalf("活跃码 %d 条，想要 1（uq_email_tokens_live 的语义）", live)
	}
	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "resender", Code: newCode}); err != nil {
		t.Fatalf("新码校验失败: %v", err)
	}
}

// 用例 46：已验证账号请求重发 → 409 auth.email_already_verified。
func TestResendRejectsVerifiedAccount(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("already", "passw0rd-1", "user")
	actor := f.actor(f.login("already", "passw0rd-1"))
	_, err := f.svc.ResendVerify(f.ctx, actor, "127.0.0.1")
	if errCode(err) != "auth.email_already_verified" {
		t.Fatalf("重发 -> %v（code=%q）", err, errCode(err))
	}
}

// 没有发信账号时重发 → 503 auth.mail_unavailable（自适应降级已作废，拍板 §12.2）。
func TestResendWithoutMailAccountsFails(t *testing.T) {
	f := newFixture(t, func(d *Deps) { d.Mail = noMailAccounts{} })
	f.seedRBAC()
	f.newUserRow("manual", "passw0rd-1", "user", false)
	actor := f.actor(f.login("manual", "passw0rd-1"))
	_, err := f.svc.ResendVerify(f.ctx, actor, "127.0.0.1")
	if errCode(err) != "auth.mail_unavailable" {
		t.Fatalf("重发 -> %v（code=%q），想要 auth.mail_unavailable", err, errCode(err))
	}
}

// auto_activate=false 时重发 → 409：**没有码可发**（拍板 §12.2 表格的最后一列）。
func TestResendDisabledInManualMode(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUserRow("noc0de", "passw0rd-1", "user", false)
	f.set.value = false // 开关真源 = 站点设置（D29）
	actor := f.actor(f.login("noc0de", "passw0rd-1"))
	_, err := f.svc.ResendVerify(f.ctx, actor, "127.0.0.1")
	if errCode(err) != "auth.resend_disabled" {
		t.Fatalf("人工激活模式下重发 -> %v（code=%q），想要 auth.resend_disabled", err, errCode(err))
	}
}

// 用例 47：找回密码不暴露邮箱是否存在——存在与不存在都返回 nil，且都落一条码/不落码。
func TestForgotPasswordDoesNotLeakExistence(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("known", "passw0rd-1", "user")

	if err := f.svc.ForgotPassword(f.ctx, "known@example.com", "127.0.0.1"); err != nil {
		t.Fatalf("已知邮箱 -> %v（必须恒 nil）", err)
	}
	if err := f.svc.ForgotPassword(f.ctx, "nobody@example.com", "127.0.0.1"); err != nil {
		t.Fatalf("未知邮箱 -> %v（必须恒 nil）", err)
	}
	var n int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM email_tokens WHERE purpose = 'reset'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("reset 码 %d 条，只有已存在的邮箱该收到码", n)
	}
}

// 用例 48/49 + 拍板 §11.7：verify-code 拿票据 → reset 用票据改密码 → 票据一次性、全部会话被删。
func TestPasswordResetTwoSteps(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("resetme", "passw0rd-1", "user")
	tok := f.login("resetme", "passw0rd-1")

	if err := f.svc.ForgotPassword(f.ctx, "resetme@example.com", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	code := f.sent.get(t)

	ticket, err := f.svc.VerifyResetCode(f.ctx, VerifyCodeInput{Login: "resetme", Code: code, IP: "127.0.0.1"})
	if err != nil {
		t.Fatalf("第一步失败: %v", err)
	}
	if ticket.Ticket == "" {
		t.Fatal("没拿到 reset_ticket")
	}
	if got := ticket.ExpiresAt.Sub(f.clk.Now()); got != codeTTL {
		t.Fatalf("票据有效期 %v，想要 %v", got, codeTTL)
	}
	// 码没有被消费：库里那条 reset 行仍在（它现在装的是票据的摘要，见 email.go 的说明）。
	var n int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM email_tokens WHERE purpose = 'reset' AND used_at IS NULL").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("第一步后活跃 reset 行 %d 条，想要 1", n)
	}

	if err := f.svc.ResetPassword(f.ctx, ResetPasswordInput{
		Ticket: ticket.Ticket, NewPassword: "brand-new-pw-9", IP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("第二步失败: %v", err)
	}

	// 票据一次性：第二次 400（拍板 §10.4/§11.8 的一次性语义）。
	err = f.svc.ResetPassword(f.ctx, ResetPasswordInput{
		Ticket: ticket.Ticket, NewPassword: "another-pw-88", IP: "127.0.0.1",
	})
	if !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("同一张票据用第二次 -> %v，想要 ErrTokenInvalid", err)
	}

	// 全部会话被删：旧 cookie 立刻失效。
	if _, err := f.svc.Resolve(f.ctx, tok); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("重置密码后旧会话仍有效: %v", err)
	}
	// 旧口令失效、新口令可用。
	if _, err2 := f.svc.Login(f.ctx, LoginInput{Login: "resetme", Password: "passw0rd-1", IP: "127.0.0.1"}); errCode(err2) != "auth.bad_credentials" {
		t.Fatalf("旧口令还能登录: %v", err)
	}
	if _, err := f.svc.Login(f.ctx, LoginInput{Login: "resetme", Password: "brand-new-pw-9", IP: "127.0.0.1"}); err != nil {
		t.Fatalf("新口令登录失败: %v", err)
	}
}

// 票据过期：10 分钟后不可用。
func TestResetTicketExpires(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("slowreset", "passw0rd-1", "user")
	if err := f.svc.ForgotPassword(f.ctx, "slowreset@example.com", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	ticket, err := f.svc.VerifyResetCode(f.ctx, VerifyCodeInput{Login: "slowreset", Code: f.sent.get(t), IP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	f.clk.T = f.clk.T.Add(11 * time.Minute)
	err = f.svc.ResetPassword(f.ctx, ResetPasswordInput{Ticket: ticket.Ticket, NewPassword: "late-pw-9999", IP: "127.0.0.1"})
	if !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("过期票据 -> %v，想要 ErrTokenInvalid", err)
	}
}

// 找回密码的码也吃 5 次上限（拍板 §11.7：两条流程同一套上限）。
func TestResetCodeSharesAttemptLimit(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("resetbrute", "passw0rd-1", "user")
	if err := f.svc.ForgotPassword(f.ctx, "resetbrute@example.com", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	code := f.sent.get(t)
	wrong := "000001"
	if wrong == code {
		wrong = "000002"
	}
	for i := 0; i < maxCodeAttempts; i++ {
		if _, err := f.svc.VerifyResetCode(f.ctx, VerifyCodeInput{Login: "resetbrute", Code: wrong, IP: "127.0.0.1"}); !errors.Is(err, ErrTokenInvalid) {
			t.Fatalf("第 %d 次 -> %v", i+1, err)
		}
	}
	if _, err := f.svc.VerifyResetCode(f.ctx, VerifyCodeInput{Login: "resetbrute", Code: code, IP: "127.0.0.1"}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("5 次失败后正确码仍然有效: %v", err)
	}
}

// 审计动作名：重置密码写的是 auth.password.change（设计 §8.10 的动作清单）。
func TestResetPasswordWritesAudit(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("auditreset", "passw0rd-1", "user")
	if err := f.svc.ForgotPassword(f.ctx, "auditreset@example.com", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	ticket, err := f.svc.VerifyResetCode(f.ctx, VerifyCodeInput{Login: "auditreset", Code: f.sent.get(t), IP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.ResetPassword(f.ctx, ResetPasswordInput{Ticket: ticket.Ticket, NewPassword: "pw-abcdefgh", IP: "127.0.0.1"}); err != nil {
		t.Fatal(err)
	}
	var action string
	if err := f.pool.QueryRow(f.ctx, "SELECT action FROM audit_logs").Scan(&action); err != nil {
		t.Fatal(err)
	}
	if action != ActionPasswordChange {
		t.Fatalf("action = %q，想要 %q", action, ActionPasswordChange)
	}
}

// 未激活用户的写闸门错误码是 auth.not_activated（拍板 §9.4）：中间件用它，这里只保证码本身存在且是 403。
func TestNotActivatedErrorShape(t *testing.T) {
	var ae *apperr.Error
	if !errors.As(error(ErrNotActivated), &ae) {
		t.Fatal("ErrNotActivated 不是 *apperr.Error")
	}
	if ae.Code != "auth.not_activated" || ae.Status != 403 {
		t.Fatalf("code=%q status=%d", ae.Code, ae.Status)
	}
}
