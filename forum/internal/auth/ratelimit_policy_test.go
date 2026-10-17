package auth

import (
	"context"
	"testing"
	"time"
)

// recordingLimiter 记录每一次限流判定的 (key, limit, window)，把**额度表本身**钉住：
// 限流参数是安全与体验的权衡，改动必须是有意的、可被 review 的。
//
// 起因（2026-10-16 用户报 request_id 42c1eee284e6504a）：注册 → 429 auth.too_many_requests。
// 原额度是 3 次/小时，而限流器是**固定窗口**计数（platform/ratelimit/memlimit）——
// 被拒之后要等满整个窗口，于是「3 次重试 = 锁一小时」，而那 3 次重试还是被
// 昵称校验的 500（ent 按字节算长度，已修）烧掉的。
type recordingLimiter struct{ calls []limitCall }

type limitCall struct {
	key   string
	limit int
	win   time.Duration
}

func (r *recordingLimiter) Allow(_ context.Context, key string, limit int, win time.Duration) (bool, time.Duration, error) {
	r.calls = append(r.calls, limitCall{key: key, limit: limit, win: win})
	return true, 0, nil
}

func (r *recordingLimiter) find(prefix string) (limitCall, bool) {
	for _, c := range r.calls {
		if len(c.key) >= len(prefix) && c.key[:len(prefix)] == prefix {
			return c, true
		}
	}
	return limitCall{}, false
}

func TestRegisterRateLimitIsTenPerTenMinutes(t *testing.T) {
	lim := &recordingLimiter{}
	f := newFixture(t, func(d *Deps) { d.Limiter = lim })
	f.seedRBAC()
	f.register("rlimit", "passw0rd-1")

	attempt, ok := lim.find("auth:register:attempt:ip:")
	if !ok {
		t.Fatal("注册没有走尝试池（这条闸必须一直在）")
	}
	if attempt.limit != 60 || attempt.win != time.Hour {
		t.Fatalf("注册尝试池 = %d 次 / %v，想要 60 次 / 1 小时", attempt.limit, attempt.win)
	}
	success, ok := lim.find("auth:register:success:ip:")
	if !ok {
		t.Fatal("注册没有走成功池（批量造号的闸）")
	}
	if success.limit != 3 || success.win != time.Hour {
		t.Fatalf("注册成功池 = %d 次 / %v，想要 3 次 / 1 小时", success.limit, success.win)
	}
}

func TestForgotPasswordRateLimitIsFivePerTenMinutes(t *testing.T) {
	lim := &recordingLimiter{}
	f := newFixture(t, func(d *Deps) { d.Limiter = lim })
	f.seedRBAC()
	if err := f.svc.ForgotPassword(f.ctx, "nobody@example.com", "1.2.3.4"); err != nil {
		t.Fatal(err)
	}
	c, ok := lim.find("auth:mail:ip:")
	if !ok {
		t.Fatal("找回密码没有走限流")
	}
	if c.limit != 5 || c.win != 10*time.Minute {
		t.Fatalf("找回密码限流 = %d 次 / %v，想要 5 次 / 10 分钟", c.limit, c.win)
	}
}

// 登录两道闸**没动**（撞库面，放宽额度是安全权衡）：10 次/分钟/IP + 5 次/分钟/登录名。
func TestLoginRateLimitsUnchanged(t *testing.T) {
	lim := &recordingLimiter{}
	f := newFixture(t, func(d *Deps) { d.Limiter = lim })
	f.seedRBAC()
	f.newUser("llimit", "passw0rd-1", "user")
	_, _ = f.svc.Login(f.ctx, LoginInput{Login: "llimit", Password: "passw0rd-1", IP: "5.6.7.8"})

	ip, ok := lim.find("auth:login:ip:")
	if !ok || ip.limit != 10 || ip.win != time.Minute {
		t.Fatalf("登录按 IP = %+v，想要 10 次/分钟", ip)
	}
	usr, ok := lim.find("auth:login:user:")
	if !ok || usr.limit != 5 || usr.win != time.Minute {
		t.Fatalf("登录按登录名 = %+v，想要 5 次/分钟", usr)
	}
}
// 失败**不吃**成功额度：这是用户定口径的核心（「失败与成功分开算」）。
// 造一个「预检之后的失败」：不 seedRBAC —— 事务里找 user 角色那一步会失败，
// 它发生在唯一性预检之后、插入之前，与用户报的那 3 次昵称 500 属于同一类。
func TestRegisterSuccessPoolOnlyCountsRealRegistrations(t *testing.T) {
	lim := &recordingLimiter{}
	f := newFixture(t, func(d *Deps) { d.Limiter = lim })
	if _, err := f.svc.Register(f.ctx, RegisterInput{
		Username: "norole", Email: "norole@example.com", Password: "passw0rd-1", IP: "9.9.9.9",
	}); err == nil {
		t.Fatal("没有 user 角色时注册应当失败")
	}
	if _, ok := lim.find("auth:register:success:ip:"); ok {
		t.Fatal("失败的注册吃掉了成功额度；失败与成功必须分开算")
	}
	if _, ok := lim.find("auth:register:attempt:ip:"); !ok {
		t.Fatal("失败的注册应当只吃尝试池")
	}
}
