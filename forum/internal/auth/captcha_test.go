package auth

// 图形验证码在 auth 侧的接线测试（三模式语义 + 错误码 + 成功清零）。
// 出题器本身的用例在 internal/platform/captcha；这里只证明「auth 按 mode 真的做了事」。
import (
	"context"
	"errors"
	"testing"

	"forum/internal/platform/captcha"
)

// captchaStub 是 Captcha 接口的假实现：其行为与 platform/captcha 一致的部分是
// 「一道题只有一次机会」与「Required 由 mode + 失败次数决定」。
type captchaStub struct {
	mode     string
	issuedAt int      // Issue 调用次数
	answers  []string // 第 n 次 Issue 的答案
	fail     map[string]int
	reset    int
}

func newCaptchaStub(mode string) *captchaStub {
	return &captchaStub{mode: mode, fail: map[string]int{}}
}

func (c *captchaStub) Issue(context.Context) (string, []byte, error) {
	c.issuedAt++
	c.answers = append(c.answers, "ABCD")
	return "id-ABCD", []byte{0x89, 0x50, 0x4E, 0x47}, nil
}

func (c *captchaStub) Verify(_ context.Context, id, answer string) error {
	if id != "id-ABCD" || answer != "ABCD" {
		return captcha.ErrWrong
	}
	return nil
}

func (c *captchaStub) Required(_ context.Context, ip, mode string) bool {
	switch mode {
	case captcha.ModeAlways:
		return true
	case captcha.ModeOnFailure:
		return c.fail[ip] >= 5
	default:
		return false
	}
}

func (c *captchaStub) CountFailure(_ context.Context, ip string) { c.fail[ip]++ }
func (c *captchaStub) ResetFailures(_ context.Context, ip string) {
	c.reset++
	delete(c.fail, ip)
}

const testIP = "127.0.0.1"

// mode=always：没带验证码 400 auth.captcha_required；答错 400 auth.captcha_wrong；答对才过。
func TestCaptchaAlwaysRequiresAnswer(t *testing.T) {
	stub := newCaptchaStub(captcha.ModeAlways)
	f := newFixture(t, func(d *Deps) { d.Captcha = stub })
	f.seedRBAC()
	f.cfg.Captcha.Mode = captcha.ModeAlways

	_, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "user1", Email: "user1@example.com", Password: "passw0rd-1", IP: testIP,
	})
	if !errors.Is(err, ErrCaptchaRequired) {
		t.Fatalf("不带验证码必须是 auth.captcha_required，得到 %v", err)
	}
	_, err = f.svc.Register(f.ctx, RegisterInput{
		Username: "user1", Email: "user1@example.com", Password: "passw0rd-1", IP: testIP,
		CaptchaID: "id-ABCD", CaptchaAnswer: "WXYZ",
	})
	if !errors.Is(err, ErrCaptchaWrong) {
		t.Fatalf("答错必须是 auth.captcha_wrong，得到 %v", err)
	}
	out, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "user1", Email: "user1@example.com", Password: "passw0rd-1", IP: testIP,
		CaptchaID: "id-ABCD", CaptchaAnswer: "ABCD",
	})
	if err != nil {
		t.Fatalf("答对必须放行，得到 %v", err)
	}
	if out.Handle != "user1" {
		t.Fatalf("注册结果不对: %+v", out)
	}
	// 成功必须清零：这条钉住「注册成功也走 resetLoginFailures」——
	// 少一次清零，被刷的 IP 会一直挂着验证码要求（正常用户偶尔打错也一样）。
	if stub.reset == 0 {
		t.Fatal("注册成功没有清零失败计数")
	}
}

// mode=off：不看验证码（注册页在没有验证码服务时也照样能提交）。
func TestCaptchaOffIgnoresAnswer(t *testing.T) {
	stub := newCaptchaStub(captcha.ModeOff)
	f := newFixture(t, func(d *Deps) { d.Captcha = stub })
	f.seedRBAC()
	f.cfg.Captcha.Mode = captcha.ModeOff

	if _, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "user2", Email: "user2@example.com", Password: "passw0rd-1", IP: testIP,
		CaptchaID: "id-ABCD", CaptchaAnswer: "WXYZ",
	}); err != nil {
		t.Fatalf("off 模式不该校验验证码，得到 %v", err)
	}
}

// mode=on_failure：连续失败 5 次之后才开始要求；此时不带验证码就不能再试。
// 这条同时钉住「失败计数真的接在登录路径上」——否则失败多少次都不会要求验证码。
func TestCaptchaOnFailureAfterFiveFailures(t *testing.T) {
	stub := newCaptchaStub(captcha.ModeOnFailure)
	f := newFixture(t, func(d *Deps) { d.Captcha = stub })
	f.seedRBAC()
	f.cfg.Captcha.Mode = captcha.ModeOnFailure
	f.newUser("tangtian", "passw0rd-1", "user")

	for i := 1; i <= 5; i++ {
		_, err := f.svc.Login(f.ctx, LoginInput{Login: "tangtian", Password: "wrong-pw", IP: testIP})
		if !errors.Is(err, ErrBadCredentials) {
			t.Fatalf("第 %d 次错密码应当是 auth.bad_credentials，得到 %v", i, err)
		}
		if want := i >= 5; stub.Required(f.ctx, testIP, captcha.ModeOnFailure) != want {
			t.Fatalf("第 %d 次失败后 required=%v，期望 %v", i, !want, want)
		}
	}
	// 阈值已到：不带验证码 -> captcha_required；带上对的 -> 密码对就能登录。
	if _, err := f.svc.Login(f.ctx, LoginInput{Login: "tangtian", Password: "passw0rd-1", IP: testIP}); !errors.Is(err, ErrCaptchaRequired) {
		t.Fatalf("阈值到了却不带验证码，应当是 auth.captcha_required，得到 %v", err)
	}
	if _, err := f.svc.Login(f.ctx, LoginInput{
		Login: "tangtian", Password: "passw0rd-1", IP: testIP, CaptchaID: "id-ABCD", CaptchaAnswer: "ABCD",
	}); err != nil {
		t.Fatalf("带上正确验证码后应当登录成功，得到 %v", err)
	}
	// 成功清零：下一次不带验证码也能登录（否则正常用户会被永远要求验证码）。
	if stub.reset == 0 {
		t.Fatal("登录成功没有清零失败计数")
	}
	if _, err := f.svc.Login(f.ctx, LoginInput{Login: "tangtian", Password: "passw0rd-1", IP: testIP}); err != nil {
		t.Fatalf("成功清零之后应当回复到不要求验证码，得到 %v", err)
	}
}

// 没装配（captcha.mode=off 且 app 层传 nil）时不能 panic、也不能凭空要求验证码。
func TestCaptchaNilIsOff(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.cfg.Captcha.Mode = captcha.ModeAlways // 配置写着 always 但没装配：按 off 兜底，不 panic
	if _, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "user3", Email: "user3@example.com", Password: "passw0rd-1", IP: testIP,
	}); err != nil {
		t.Fatalf("没装配验证码时应当按 off 放行，得到 %v", err)
	}
}
