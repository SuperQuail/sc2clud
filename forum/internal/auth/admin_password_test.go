package auth

// 管理员重置密码（用户忘记密码时的后台通道）的三条钉子：
//   无 user.ban 被拒（HTTP 层 401/403）；
//   显式密码 —— 新密码能登录、旧密码不能、旧会话全部失效、审计不含密码值；
//   空密码    —— 生成一次性临时密码（12 位、无易混字符），用它可登录。

import (
	"encoding/json"
	"strings"
	"testing"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// publicIDOf 取用户的 public_id（路由与 service 都收它，不接受自增 id）。
func (f *fixture) publicIDOf(username string) string {
	f.t.Helper()
	var pid string
	if err := f.pool.QueryRow(f.ctx, "SELECT public_id::text FROM users WHERE username = $1", username).Scan(&pid); err != nil {
		f.t.Fatalf("取 %s 的 public_id 失败: %v", username, err)
	}
	return pid
}

// superadminActor 造一个**真有 user.ban** 的管理员：权限集合来自 DB 的 role_permissions，
// 不是手编的 Set（actorWith空集合只会 403）。
func (f *fixture) superadminActor() *authz.Actor {
	f.t.Helper()
	f.newUser("boss", "pw-boss-1", "superadmin")
	return f.actor(f.login("boss", "pw-boss-1"))
}

// detailGenerated 读审计 detail 的 after.generated：jsonb 的空格排版有变体，按值读不按串找。
func detailGenerated(detail string) bool {
	var m struct {
		After struct {
			Generated bool `json:"generated"`
		} `json:"after"`
	}
	_ = json.Unmarshal([]byte(detail), &m)
	return m.After.Generated
}

// lastPWResetAudit 取该用户最近一条**重置**审计：action 与 detail 文本。
// 名字里的重置不遮别的动作：重置之后往往紧跟着一次登录，不按 action 过滤会读到登录行。
func (f *fixture) lastPWResetAudit(publicID string) (string, string) {
	f.t.Helper()
	var action, detail string
	err := f.pool.QueryRow(f.ctx,
		"SELECT action, detail::text FROM audit_logs WHERE target_id = $1 AND action = 'user.password.reset' ORDER BY id DESC LIMIT 1",
		publicID).Scan(&action, &detail)
	if err != nil {
		f.t.Fatalf("查审计失败: %v", err)
	}
	return action, detail
}

// 没有 user.ban 的人必须是 403（游客 401）。这条同时证明路由真的挂上了：
// 路由不存在时 gin 会 panic（见 admin_users_test.go 同款）。
func TestAdminSetPasswordRouteGuards(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("alice", "pw-alice-1", "user")
	target := f.publicIDOf("alice")
	r := f.newAdminRouter()

	if w := f.doJSON(r, "POST", "/api/v1/admin/users/"+target+"/password", "", `{}`); w.Code != 401 {
		t.Fatalf("游客必须是 401，实际 %d：%s", w.Code, w.Body.String())
	}
	tok := f.login("alice", "pw-alice-1")
	rej := f.doJSON(r, "POST", "/api/v1/admin/users/"+target+"/password", tok, `{}`)
	if rej.Code != 403 {
		t.Fatalf("没有 user.ban 必须是 403，实际 %d：%s", rej.Code, rej.Body.String())
	}
	if code := errCodeOfBody(t, rej.Body.Bytes()); code != apperr.CodeForbidden {
		t.Fatalf("错误码应当是 %s，实际 %s", apperr.CodeForbidden, code)
	}
	// 被拒的路径不该改动目标：旧密码还能登录。
	f.login("alice", "pw-alice-1")
}

// 显式指定密码：新密码可登录、旧密码不可、既有会话被踢、审计不含密码值。
func TestAdminSetPasswordExplicitKicksSessions(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("bob", "pw-bob-1", "user")
	target := f.publicIDOf("bob")
	targetTok := f.login("bob", "pw-bob-1")
	admin := f.superadminActor()

	out, err := f.svc.AdminSetPassword(f.ctx, admin, AdminSetPasswordInput{
		UserPublicID: target, Password: "reset-pass-2026", IP: "127.0.0.1",
	})
	if err != nil {
		t.Fatalf("AdminSetPassword: %v", err)
	}
	if out.Password != "" {
		t.Fatalf("显式设置的密码不得回显，实际 %q", out.Password)
	}
	if out.Revoked < 1 {
		t.Fatalf("应当踢掉既有会话，实际 %d", out.Revoked)
	}
	if _, err := f.svc.Resolve(f.ctx, targetTok); err == nil {
		t.Fatal("旧会话必须已失效")
	}
	f.login("bob", "reset-pass-2026") // 新密码可登录（登录失败会 Fatal）
	if _, err := f.svc.Login(f.ctx, LoginInput{Login: "bob", Password: "pw-bob-1", IP: "127.0.0.1"}); err == nil {
		t.Fatal("旧密码必须不能登录")
	}

	action, detail := f.lastPWResetAudit(target)
	if action != ActionUserPasswordReset {
		t.Fatalf("审计动作应当是 %s，实际 %s", ActionUserPasswordReset, action)
	}
	if strings.Contains(detail, "reset-pass-2026") {
		t.Fatal("审计 detail 不得包含密码值：" + detail)
	}
	if detailGenerated(detail) {
		t.Fatal("显式设置的审计不得标注 generated=true：" + detail)
	}
}

// 空密码：生成 12 位临时密码（字符表内、无易混字符），把它登录成功可以证明真的可交付。
func TestAdminSetPasswordGenerated(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("bob", "pw-bob-1", "user")
	target := f.publicIDOf("bob")
	admin := f.superadminActor()

	out, err := f.svc.AdminSetPassword(f.ctx, admin, AdminSetPasswordInput{
		UserPublicID: target, Password: "", IP: "127.0.0.1",
	})
	if err != nil {
		t.Fatalf("AdminSetPassword: %v", err)
	}
	if len(out.Password) != 12 {
		t.Fatalf("临时密码应当 12 位，实际 %d 位", len(out.Password))
	}
	for _, c := range out.Password {
		if !strings.ContainsRune(temporaryPasswordChars, c) {
			t.Fatalf("临时密码出现字符表外/易混字符 %q（%s）", c, out.Password)
		}
	}
	f.login("bob", out.Password) // 生成密码真实可用

	_, detail := f.lastPWResetAudit(target)
	if generated := detailGenerated(detail); !generated {
		t.Fatal("审计 detail 应当标注 generated=true：" + detail)
	}

	// 太短/全空的非空显式密码：走 validatePassword 而不是静默改走生成路。
	if _, err := f.svc.AdminSetPassword(f.ctx, admin, AdminSetPasswordInput{UserPublicID: target, Password: "short"}); err == nil {
		t.Fatal("过短的显式密码必须被拒")
	}
}
