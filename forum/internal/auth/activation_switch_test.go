package auth

// D29 的手动激活开关：**站点设置**（auth.registration.auto_activate）是唯一开关，
// 配置里的 auth.auto_activate 只是它没配时的默认值。
//
// 两条路径必须联动：
//   打开 → 注册后发验证码，用户自助激活（重发可用）；
//   关掉 → 注册不发码、等管理员手工激活（重发 409 auth.resend_disabled：没有码可发）。
//
// 这四条用例在**只认 config** 的实现下全红：那时把站点设置改成 off 一点作用都没有。

import "testing"

func TestSiteSettingTurnedOffStopsCodeAndBlocksResend(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	// 配置默认开着（cfg 是 config.Default()，auto_activate 为 nil = true）：
	// 这一条证明「关掉」这件事只可能来自站点设置。
	f.set.value = false

	out := f.register("manual-on", "passw0rd-1")
	if out.AutoActivate {
		t.Fatal("站点设置关掉了，注册回执里的 auto_activate 仍是 true")
	}
	if f.queue.count() != 0 {
		t.Fatalf("人工激活模式下入了 %d 条发信任务（不该发任何码）", f.queue.count())
	}
	var tokens int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM email_tokens").Scan(&tokens); err != nil {
		t.Fatal(err)
	}
	if tokens != 0 {
		t.Fatalf("人工激活模式下写了 %d 条验证码", tokens)
	}

	actor := f.actor(f.login("manual-on", "passw0rd-1"))
	// 未激活 → 能登录、写操作被 403 挡（拍板 §9.12）；激活前不该能自助拿到码。
	me, err := f.svc.Me(f.ctx, actor)
	if err != nil {
		t.Fatal(err)
	}
	if me.AutoActivate {
		t.Fatal("me.auto_activate 没跟着站点设置走")
	}
	_, err = f.svc.ResendVerify(f.ctx, actor, "127.0.0.1")
	if errCode(err) != "auth.resend_disabled" {
		t.Fatalf("关掉开关后重发 -> %v（code=%q），想要 auth.resend_disabled", err, errCode(err))
	}
}

// 关掉再打开 = 自助激活这条路**回来**：未激活账号能再发码（D29 的后半句：
// 「关掉后未激活账号可再发码自助激活」）。
func TestSiteSettingTurnedBackOnRestoresSelfService(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.set.value = false
	f.register("toggled", "passw0rd-1")

	actor := f.actor(f.login("toggled", "passw0rd-1"))
	if _, err := f.svc.ResendVerify(f.ctx, actor, "127.0.0.1"); errCode(err) != "auth.resend_disabled" {
		t.Fatalf("前提不成立：关掉时重发应当被拒，实际 %v", err)
	}

	f.set.value = true
	out, err := f.svc.ResendVerify(f.ctx, actor, "127.0.0.1")
	if err != nil {
		t.Fatalf("开关打开后重发失败: %v", err)
	}
	if !out.Sent {
		t.Fatal("开关打开后重发没有投出去")
	}
	if f.queue.count() != 1 {
		t.Fatalf("打开后应当入队 1 条发信任务，实际 %d", f.queue.count())
	}
	// 重发出来的码能真的把账号激活 —— 「自助激活」这条路是通的，不是只发了一封信。
	code := f.sent.get(t)
	if err := f.svc.VerifyEmailCode(f.ctx, VerifyCodeInput{Login: "toggled", Code: code}); err != nil {
		t.Fatalf("用重发的码激活失败: %v", err)
	}
}

// 打开（默认）时注册照旧发码：证明上面那条不是因为「开关恒为 false」而绿。
func TestSiteSettingOnKeepsSelfServiceRegistration(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.set.value = true
	out := f.register("selfserve", "passw0rd-1")
	if !out.AutoActivate {
		t.Fatal("开关打开时注册回执应当说 auto_activate=true")
	}
	if f.queue.count() != 1 {
		t.Fatalf("打开时注册应当入队 1 条发信任务，实际 %d", f.queue.count())
	}
	if f.sent.get(t) == "" {
		t.Fatal("打开时注册没有发出验证码")
	}
}

// 管理员手工激活是关掉开关后的**唯一**入口：走通它，并且只动 activated_at。
func TestAdminActivationWorksWhileSettingOff(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.set.value = false
	f.register("waiting", "passw0rd-1")

	root := f.newSuperAdmin("root")
	var pub string
	if err := f.pool.QueryRow(f.ctx, "SELECT public_id FROM users WHERE username = 'waiting'").Scan(&pub); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.ActivateUser(f.ctx, root, pub, "127.0.0.1"); err != nil {
		t.Fatalf("管理员激活失败: %v", err)
	}
	actor := f.actor(f.login("waiting", "passw0rd-1"))
	if !actor.Activated {
		t.Fatal("激活后 actor.Activated 仍是 false")
	}
	// 开关仍是关着：手工激活**不改**开关本身，只是这一个账号过关了 —— 下一个人还要走同一条路
	if f.svc.autoActivate(f.ctx) {
		t.Fatal("手工激活把开关改掉了：关掉的状态必须保持关掉")
	}
}
