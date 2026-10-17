package auth

// 批量操作用户的用例（交接单 C6）。**先确认会红**：路由不存在时是 404。

import (
	"encoding/json"
	"testing"

	"forum/internal/platform/apperr"
)

// admin_batch_test.go 的本地小工具。

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// countAudit 数某类审计的行数。
func (f *fixture) countAudit(t *testing.T, action string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM audit_logs WHERE action = $1", action).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (f *fixture) userPublicID(t *testing.T, username string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(f.ctx, "SELECT public_id FROM users WHERE username = $1", username).Scan(&id); err != nil {
		t.Fatalf("取 %s 的 public_id 失败: %v", username, err)
	}
	return id
}

func (f *fixture) statusOf(t *testing.T, username string) string {
	t.Helper()
	var s string
	if err := f.pool.QueryRow(f.ctx, "SELECT status FROM users WHERE username = $1", username).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func (f *fixture) activatedOf(t *testing.T, username string) bool {
	t.Helper()
	var ok bool
	if err := f.pool.QueryRow(f.ctx,
		"SELECT activated_at IS NOT NULL FROM users WHERE username = $1", username).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

func (f *fixture) roleKeyOf(t *testing.T, username string) string {
	t.Helper()
	var k string
	if err := f.pool.QueryRow(f.ctx,
		"SELECT r.key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = $1", username).Scan(&k); err != nil {
		t.Fatal(err)
	}
	return k
}

// batchFixtures 种 root（超管）、boss（admin 角色：有 user.ban，**没有 role.assign**）
// 与三个普通用户。返回 (超管令牌, admin 令牌)。
func batchFixtures(t *testing.T, f *fixture) (string, string) {
	t.Helper()
	f.seedRBAC()
	f.newUser("root", "pw-root-11", "superadmin")
	f.newUser("boss", "pw-boss-11", "admin")
	f.newUser("u1", "pw-u1-1111", "user")
	f.newUser("u2", "pw-u2-1111", "user")
	f.newUserRow("u3", "pw-u3-1111", "user", false)
	return f.login("root", "pw-root-11"), f.login("boss", "pw-boss-11")
}

// ── 守卫 ──────────────────────────────────────────────────────────

// 没有 user.ban 打批量 → 403；游客 → 401。
func TestBatchUsersGuards(t *testing.T) {
	f := newFixture(t)
	_, _ = batchFixtures(t, f)
	f.newUser("nobody", "pw-nobody-1", "user")
	r := f.newAdminRouter()

	if w := f.doJSON(r, "POST", "/api/v1/admin/users/batch", "", `{"ids":["x"],"action":"ban"}`); w.Code != 401 {
		t.Fatalf("游客必须是 401，实际 %d：%s", w.Code, w.Body.String())
	}
	tok := f.login("nobody", "pw-nobody-1")
	w := f.doJSON(r, "POST", "/api/v1/admin/users/batch", tok, `{"ids":["x"],"action":"ban"}`)
	if w.Code != 403 {
		t.Fatalf("没有 user.ban 必须是 403，实际 %d：%s", w.Code, w.Body.String())
	}
}

// 整批级的参数错误走 400（它们不是「某一条失败」，是这次请求本身不成立）。
func TestBatchUsersRejectsBadRequest(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := batchFixtures(t, f)
	root := f.actor(rootTok)

	for _, c := range []struct {
		name string
		in   BatchUsersInput
	}{
		{"空 ids", BatchUsersInput{Action: BatchActionBan}},
		{"非法 action", BatchUsersInput{IDs: []string{"x"}, Action: "nuke"}},
		{"没有 action", BatchUsersInput{IDs: []string{"x"}}},

		{"超过上限", BatchUsersInput{IDs: make([]string, maxBatchUsers+1), Action: BatchActionBan}},
	} {
		if _, err := f.svc.BatchUsers(f.ctx, root, c.in); err == nil {
			t.Fatalf("%s：必须是参数错误", c.name)
		}
	}
	// 游客打进来也是 401（service 层兜底）
	if _, err := f.svc.BatchUsers(f.ctx, nil, BatchUsersInput{IDs: []string{"x"}, Action: BatchActionBan}); err == nil {
		t.Fatal("游客必须被拒")
	}
	// set_role 缺 role_id 是**逐条**失败（每条都是「这一条不成立」），不是整批 400 ——
	// 一条请求里混着别的动作时，整批 400 会把能做的也挡掉。
	res, err := f.svc.BatchUsers(f.ctx, root, BatchUsersInput{
		IDs: []string{"00000000-0000-0000-0000-000000000000"}, Action: BatchActionSetRole,
	})
	if err != nil || res.Failed != 1 || res.Items[0].Error == nil || res.Items[0].Error.Code != apperr.CodeInvalidInput {
		t.Fatalf("缺 role_id 应当是逐条 %s，实际 res=%+v err=%v", apperr.CodeInvalidInput, res, err)
	}
}

// ── 会红的那条（HTTP 层） ─────────────────────────────────────────

func TestBatchUsersHTTPEnvelope(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := batchFixtures(t, f)
	r := f.newAdminRouter()

	u1 := f.userPublicID(t, "u1")
	body := `{"ids":["` + u1 + `"],"action":"ban","reason":"刷屏"}`
	w := f.doJSON(r, "POST", "/api/v1/admin/users/batch", rootTok, body)
	if w.Code != 200 {
		t.Fatalf("批量停用应当 200，实际 %d：%s", w.Code, w.Body.String())
	}
	var env struct {
		Data BatchUsersResult `json:"data"`
	}
	if err := jsonUnmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	d := env.Data
	if d.Total != 1 || d.Succeeded != 1 || d.Failed != 0 || len(d.Items) != 1 || !d.Items[0].OK {
		t.Fatalf("回执形状不对: %+v", d)
	}
	if d.Items[0].ID != u1 {
		t.Fatalf("回执要带 id（前端按它勾掉行）: %+v", d.Items[0])
	}
	if s := f.statusOf(t, "u1"); s != StatusBanned {
		t.Fatalf("u1 应当已被停用，实际 %s", s)
	}
}

// ── 逐条返回成功失败（这一条是 C6 的核心） ────────────────────────

// 一条失败不能拖垮整批，也不能被静默跳过。
func TestBatchUsersPerItemResults(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := batchFixtures(t, f)
	root := f.actor(rootTok)

	u1 := f.userPublicID(t, "u1")
	u2 := f.userPublicID(t, "u2")
	missing := "00000000-0000-0000-0000-000000000000"

	res, err := f.svc.BatchUsers(f.ctx, root, BatchUsersInput{
		IDs: []string{u1, missing, "not-a-uuid", u2}, Action: BatchActionBan, Reason: "批量清广告",
	})
	if err != nil {
		t.Fatalf("整批级不该报错（参数都是合法的）: %v", err)
	}
	if res.Total != 4 || res.Succeeded != 2 || res.Failed != 2 {
		t.Fatalf("应当是 4 条里成功 2 失败 2，实际 total=%d ok=%d fail=%d：%+v",
			res.Total, res.Succeeded, res.Failed, res.Items)
	}
	if len(res.Items) != 4 {
		t.Fatalf("回执必须逐条给（顺序与请求一致），实际 %d 条", len(res.Items))
	}
	if !res.Items[0].OK || res.Items[0].Error != nil {
		t.Fatalf("第 0 条应当成功: %+v", res.Items[0])
	}
	if res.Items[1].OK || res.Items[1].Error == nil || res.Items[1].Error.Code != ErrAdminUserNotFound.Code {
		t.Fatalf("不存在的用户应当在这一条上报 %s: %+v", ErrAdminUserNotFound.Code, res.Items[1])
	}
	if res.Items[2].OK || res.Items[2].Error == nil || res.Items[2].Error.Code != ErrAdminUserNotFound.Code {
		t.Fatalf("非 uuid 应当在这一条上报 %s: %+v", ErrAdminUserNotFound.Code, res.Items[2])
	}
	if !res.Items[3].OK {
		t.Fatalf("第 3 条应当成功（前面的失败不能拖垮后面的）: %+v", res.Items[3])
	}
	// 成功的那两个**真的**落库了
	if s := f.statusOf(t, "u1"); s != StatusBanned {
		t.Fatalf("u1 应当已停用，实际 %s", s)
	}
	if s := f.statusOf(t, "u2"); s != StatusBanned {
		t.Fatalf("u2 应当已停用，实际 %s", s)
	}
	// 审计逐条写：两条成功的封号 = 两行 user.ban
	if n := f.countAudit(t, ActionUserBan); n != 2 {
		t.Fatalf("应当有 2 行 user.ban 审计，实际 %d", n)
	}
}

// 超级管理员不能被批量停用（guardLastSuper 在批量路径上同样生效）——
// 这条是「批量不是放宽规则」的直接证据。
func TestBatchUsersCannotBanLastSuper(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := batchFixtures(t, f)
	root := f.actor(rootTok)

	// root 是唯一一个 is_super 角色（uq_roles_super 保证库里只有一个超管角色），
	// 所以他就是「最后一名可用超管」。
	rootPub := f.userPublicID(t, "root")

	res, err := f.svc.BatchUsers(f.ctx, root, BatchUsersInput{IDs: []string{rootPub}, Action: BatchActionBan})
	if err != nil {
		t.Fatal(err)
	}
	if res.Succeeded != 0 || res.Failed != 1 {
		t.Fatalf("最后一名超管不能被停用，实际 %+v", res.Items)
	}
	if res.Items[0].Error == nil || res.Items[0].Error.Code != ErrAdminLastSuper.Code {
		t.Fatalf("错误码应当是 %s，实际 %+v", ErrAdminLastSuper.Code, res.Items[0])
	}
	if s := f.statusOf(t, "root"); s != StatusActive {
		t.Fatalf("失败的批量不该改动账号，root 现在是 %s", s)
	}
}

// 权限点逐条判：admin 有 user.ban 但没有 role.assign，
// 所以同一批里 ban 成功、set_role 失败 —— 这条同时证明「批量没有绕过权限」。
func TestBatchUsersSetRoleNeedsRoleAssign(t *testing.T) {
	f := newFixture(t)
	_, bossTok := batchFixtures(t, f)
	boss := f.actor(bossTok)

	u1 := f.userPublicID(t, "u1")
	creatorID := f.roleID("creator")

	res, err := f.svc.BatchUsers(f.ctx, boss, BatchUsersInput{
		IDs: []string{u1}, Action: BatchActionSetRole, RoleID: creatorID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Failed != 1 || res.Items[0].Error == nil {
		t.Fatalf("没有 role.assign 时 set_role 必须在这一条上失败，实际 %+v", res.Items)
	}
	if res.Items[0].Error.Code != apperr.CodeForbidden {
		t.Fatalf("错误码应当是 %s，实际 %s", apperr.CodeForbidden, res.Items[0].Error.Code)
	}
	if k := f.roleKeyOf(t, "u1"); k != "user" {
		t.Fatalf("失败的 set_role 不该改角色，u1 现在是 %s", k)
	}

	// 换成超管就成功（证明失败的原因是权限，不是请求写错了）
	root := f.actor(f.login("root", "pw-root-11"))
	res2, err := f.svc.BatchUsers(f.ctx, root, BatchUsersInput{
		IDs: []string{u1}, Action: BatchActionSetRole, RoleID: creatorID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res2.Succeeded != 1 {
		t.Fatalf("超管应当能改角色，实际 %+v", res2.Items)
	}
	if k := f.roleKeyOf(t, "u1"); k != "creator" {
		t.Fatalf("u1 的角色应当已改成 creator，实际 %s", k)
	}
}

// 批量激活：未激活的 u3 一次激活；审计要有 ActionUserActivate。
func TestBatchUsersActivate(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := batchFixtures(t, f)
	root := f.actor(rootTok)

	if f.activatedOf(t, "u3") {
		t.Fatal("夹具问题：u3 应当是未激活的")
	}
	u3 := f.userPublicID(t, "u3")
	res, err := f.svc.BatchUsers(f.ctx, root, BatchUsersInput{IDs: []string{u3}, Action: BatchActionActivate})
	if err != nil {
		t.Fatal(err)
	}
	if res.Succeeded != 1 {
		t.Fatalf("激活应当成功，实际 %+v", res.Items)
	}
	if !f.activatedOf(t, "u3") {
		t.Fatal("u3 没有被激活")
	}
	// 幂等：再来一次仍然成功（单条端点就是幂等的）
	res2, err := f.svc.BatchUsers(f.ctx, root, BatchUsersInput{IDs: []string{u3}, Action: BatchActionActivate})
	if err != nil || res2.Succeeded != 1 {
		t.Fatalf("重复激活应当成功（幂等），实际 %+v / %v", res2, err)
	}
	if n := f.countAudit(t, ActionUserActivate); n != 2 {
		t.Fatalf("两次激活应当有 2 行审计，实际 %d", n)
	}
}

// unban 把状态改回来（顺带证明同一个批量端点能做反向操作）。
func TestBatchUsersUnban(t *testing.T) {
	f := newFixture(t)
	rootTok, _ := batchFixtures(t, f)
	root := f.actor(rootTok)
	u1 := f.userPublicID(t, "u1")

	if _, err := f.svc.BatchUsers(f.ctx, root, BatchUsersInput{IDs: []string{u1}, Action: BatchActionBan}); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.BatchUsers(f.ctx, root, BatchUsersInput{IDs: []string{u1}, Action: BatchActionUnban})
	if err != nil {
		t.Fatal(err)
	}
	if res.Succeeded != 1 {
		t.Fatalf("解封应当成功，实际 %+v", res.Items)
	}
	if s := f.statusOf(t, "u1"); s != StatusActive {
		t.Fatalf("u1 应当已解封，实际 %s", s)
	}
}
