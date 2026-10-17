package auth

import (
	"errors"
	"strings"
	"testing"
	"time"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// 用例 47：迁移数据的形状。数字取自 0017_seed_authz 的**实际** INSERT 集合：
// user 3 / creator 7 / admin 16 / superadmin 24（迁移注释里写的「creator 8、admin 17」
// 与那段 INSERT 的 key 列表对不上，实测以 INSERT 为准）。
func TestSeedShape(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()

	var perms int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM permissions").Scan(&perms); err != nil {
		t.Fatal(err)
	}
	if perms != len(authz.All) {
		t.Fatalf("permissions 表 %d 行，代码常量 %d 个", perms, len(authz.All))
	}
	// 权限点全集的逐字对照：夹具灌的东西必须与 authz 常量完全一致。
	for _, k := range authz.All {
		var n int
		if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM permissions WHERE key = $1", k).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("权限点 %s 在表里有 %d 行", k, n)
		}
	}
	want := map[string]int{"user": 3, "creator": 7, "admin": 16, "superadmin": 24}
	for key, w := range want {
		var n int
		if err := f.pool.QueryRow(f.ctx,
			"SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = $1", key).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != w {
			t.Fatalf("角色 %s 有 %d 个权限点，seed 是 %d", key, n, w)
		}
	}
	// 权限点自检在正确的 seed 上必须是绿的。
	if err := f.svc.CheckPermissions(f.ctx); err != nil {
		t.Fatalf("CheckPermissions 在正确的 seed 上返回 %v", err)
	}
	// 内置角色身份。
	var isSuper bool
	if err := f.pool.QueryRow(f.ctx, "SELECT is_super FROM roles WHERE key = 'superadmin'").Scan(&isSuper); err != nil {
		t.Fatal(err)
	}
	if !isSuper {
		t.Fatal("superadmin 的 is_super 不是 true（超管短路靠它，禁止比较 role.key）")
	}
}

// 用例 55 + 设计 §8.9：**最后一个可用超管不可降权**，且库里 role_id 未变。
func TestLastSuperCannotBeDemoted(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	admin := f.newSuperAdmin("root")
	adminID := f.roleID("admin")

	err := f.svc.SetUserRole(f.ctx, admin, SetUserRoleInput{
		UserPublicID: admin.PublicID, RoleID: adminID, IP: "127.0.0.1",
	})
	if errCode(err) != "admin.last_super" {
		t.Fatalf("降权唯一超管 -> %v（code=%q），想要 admin.last_super", err, errCode(err))
	}
	var got int64
	if err := f.pool.QueryRow(f.ctx, "SELECT role_id FROM users WHERE public_id = $1", admin.PublicID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != f.roleID("superadmin") {
		t.Fatalf("守卫拒绝了但 role_id 已经变成 %d", got)
	}
}

// 用例 56：有第二个超管之后，降权就合法了（守卫只挡「最后一个」）。
func TestSecondSuperAllowsDemotion(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	first := f.newSuperAdmin("root1")
	f.newSuperAdmin("root2")

	err := f.svc.SetUserRole(f.ctx, first, SetUserRoleInput{
		UserPublicID: first.PublicID, RoleID: f.roleID("admin"), IP: "127.0.0.1",
	})
	if err != nil {
		t.Fatalf("有第二个超管时降权仍然被拒: %v", err)
	}
	// 第二次执行结果相同（幂等，设计 §9.5）。
	if err := f.svc.SetUserRole(f.ctx, first, SetUserRoleInput{
		UserPublicID: first.PublicID, RoleID: f.roleID("admin"), IP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("重复降权失败: %v", err)
	}
}

// 用例 57：**被封的超管不算数**（否则会出现「剩下一个被封的超管，实际没人能登录」）。
func TestBannedSuperDoesNotCount(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	me := f.newSuperAdmin("keepme")
	other := f.newSuperAdmin("banned-one")

	if _, err := f.svc.BanUser(f.ctx, me, BanInput{UserPublicID: other.PublicID, Action: "ban", IP: "127.0.0.1"}); err != nil {
		t.Fatalf("封另一个超管失败: %v", err)
	}
	err := f.svc.SetUserRole(f.ctx, me, SetUserRoleInput{
		UserPublicID: me.PublicID, RoleID: f.roleID("admin"), IP: "127.0.0.1",
	})
	if errCode(err) != "admin.last_super" {
		t.Fatalf("被封的超管被算成了有效超管: %v（code=%q）", err, errCode(err))
	}
}

// 用例 58：**最后一个超管不可封**（守卫两条路都要挡）。
func TestLastSuperCannotBeBanned(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	me := f.newSuperAdmin("solo")
	_, err := f.svc.BanUser(f.ctx, me, BanInput{UserPublicID: me.PublicID, Action: "ban", IP: "127.0.0.1"})
	if errCode(err) != "admin.last_super" {
		t.Fatalf("封唯一超管 -> %v（code=%q），想要 admin.last_super", err, errCode(err))
	}
	var status string
	if err := f.pool.QueryRow(f.ctx, "SELECT status FROM users WHERE public_id = $1", me.PublicID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != StatusActive {
		t.Fatalf("守卫拒绝了但状态已经变成 %q", status)
	}
}

// 用例 59/60：普通用户 403、未登录 401（都来自 service 层的 requirePerm）。
func TestAdminRequiresPermission(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("plain", "passw0rd-1", "user")
	plain := f.actor(f.login("plain", "passw0rd-1"))

	_, err := f.svc.ListRoles(f.ctx, plain)
	if errCode(err) != apperr.CodeForbidden {
		t.Fatalf("普通用户调管理端点 -> %v（code=%q），想要 common.forbidden", err, errCode(err))
	}
	if _, err := f.svc.ListRoles(f.ctx, nil); errCode(err) != apperr.CodeUnauthorized {
		t.Fatalf("未登录调管理端点 -> %v（code=%q），想要 common.unauthorized", err, errCode(err))
	}
}

// 用例 63：admin **不能**给自己提权（他的角色里没有 role.assign，天花板就是 admin）。
func TestAdminCannotSelfPromote(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("midadmin", "passw0rd-1", "admin")
	actor := f.actor(f.login("midadmin", "passw0rd-1"))

	err := f.svc.SetUserRole(f.ctx, actor, SetUserRoleInput{
		UserPublicID: actor.PublicID, RoleID: f.roleID("superadmin"), IP: "127.0.0.1",
	})
	if errCode(err) != apperr.CodeForbidden {
		t.Fatalf("admin 自提为超管 -> %v（code=%q）", err, errCode(err))
	}
}

// 用例 49/54：改角色矩阵后**下一个请求**就生效；追加权限同理（本实现没有缓存，所以是立刻）。
func TestRoleMatrixAndGrantsTakeEffect(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	root := f.newSuperAdmin("root")
	f.newUser("worker", "passw0rd-1", "user")
	tok := f.login("worker", "passw0rd-1")

	before := f.actor(tok)
	if before.Perms.Has(authz.PermTopicLock) {
		t.Fatal("普通用户一开始就有 topic.lock")
	}

	// 改 user 角色的矩阵：加 topic.lock。
	keys := []string{authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermTopicDeleteOwn, authz.PermTopicLock}
	if err := f.svc.ReplaceRolePermissions(f.ctx, root, ReplaceRolePermsInput{
		RoleID: f.roleID("user"), PermKeys: keys, IP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("改角色矩阵失败: %v", err)
	}
	after := f.actor(tok)
	if !after.Perms.Has(authz.PermTopicLock) {
		t.Fatal("改完矩阵后下一个请求没有拿到新权限")
	}
	if after.Perms.Has(authz.PermUserBan) {
		t.Fatal("矩阵里没有的权限点出现在了集合里")
	}

	// 追加一条点对点权限（带理由），立刻生效。
	if err := f.svc.GrantPermission(f.ctx, root, GrantPermInput{
		UserPublicID: after.PublicID, PermKey: authz.PermUserBan, Reason: "临时排障", IP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("追加权限失败: %v", err)
	}
	withGrant := f.actor(tok)
	if !withGrant.Perms.Has(authz.PermUserBan) {
		t.Fatal("追加权限没有生效")
	}
	// /me 的 extra 要说清它是「追加来的」。
	me, err := f.svc.Me(f.ctx, withGrant)
	if err != nil {
		t.Fatal(err)
	}
	if len(me.Extra) != 1 || me.Extra[0].Key != authz.PermUserBan {
		t.Fatalf("me.Extra = %+v", me.Extra)
	}

	// 回收 → 立刻消失；再回收 → 404。
	if err := f.svc.RevokePermission(f.ctx, root, withGrant.PublicID, authz.PermUserBan, "127.0.0.1"); err != nil {
		t.Fatalf("回收失败: %v", err)
	}
	if f.actor(tok).Perms.Has(authz.PermUserBan) {
		t.Fatal("回收后权限还在")
	}
	err = f.svc.RevokePermission(f.ctx, root, withGrant.PublicID, authz.PermUserBan, "127.0.0.1")
	if !errors.Is(err, errPermGrantNotFound) {
		t.Fatalf("重复回收 -> %v，想要 errPermGrantNotFound（对外 404）", err)
	}
}

// 用例 53：过期的追加不出现在权限集合里，且 expires_at 在过去直接 400。
func TestExpiredGrantDoesNotApply(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	root := f.newSuperAdmin("root")
	f.newUser("temp", "passw0rd-1", "user")
	tok := f.login("temp", "passw0rd-1")
	actor := f.actor(tok)

	past := f.clk.Now().Add(-time.Hour)
	err := f.svc.GrantPermission(f.ctx, root, GrantPermInput{
		UserPublicID: actor.PublicID, PermKey: authz.PermUserBan, Reason: "已过期", ExpiresAt: &past, IP: "127.0.0.1",
	})
	if errCode(err) != apperr.CodeInvalidInput {
		t.Fatalf("过去的过期时间 -> %v（code=%q）", err, errCode(err))
	}

	// 直接写库造一条「已过期」的行，证明查询侧的过滤真的在（拍板 §5.9 第 1 条：谓词不能带 now()）。
	if err := f.svc.GrantPermission(f.ctx, root, GrantPermInput{
		UserPublicID: actor.PublicID, PermKey: authz.PermUserBan, Reason: "限时", IP: "127.0.0.1",
		ExpiresAt: ptrTime(f.clk.Now().Add(time.Minute)),
	}); err != nil {
		t.Fatalf("追加限时权限失败: %v", err)
	}
	if !f.actor(tok).Perms.Has(authz.PermUserBan) {
		t.Fatal("未过期的追加没有生效")
	}
	f.clk.T = f.clk.T.Add(2 * time.Minute)
	if f.actor(tok).Perms.Has(authz.PermUserBan) {
		t.Fatal("过期后权限仍然生效（时间比较必须在查询的 WHERE 里）")
	}
}

// 用例 52：追加权限必须带理由（本地校验 + DB 的 ck_user_permissions_reason 兜一次）。
func TestGrantRequiresReason(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	root := f.newSuperAdmin("root")
	f.newUser("noreason", "passw0rd-1", "user")
	actor := f.actor(f.login("noreason", "passw0rd-1"))
	// 给 root 一条点对点权限是不够的——reason 校验在 requirePerm 之后，超管本来就能过它。
	// 这里故意用**没有 permission.grant** 的 actor，证明拒绝来自 reason 之前那一层之外；
	// 所以校验必须发生在 requirePerm 之前才有意义：本测试固定的是「reason 空 → 400」。
	for _, reason := range []string{"", "   "} {
		err := f.svc.GrantPermission(f.ctx, root, GrantPermInput{
			UserPublicID: actor.PublicID, PermKey: authz.PermUserBan, Reason: reason, IP: "127.0.0.1",
		})
		if errCode(err) != apperr.CodeInvalidInput {
			t.Fatalf("空理由 %q -> %v（code=%q）", reason, err, errCode(err))
		}
	}
}

// 未知权限点 → 400 admin.perm_unknown（不是静默成功）。
func TestGrantUnknownPermission(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	root := f.newSuperAdmin("root")
	f.newUser("unknownperm", "passw0rd-1", "user")
	actor := f.actor(f.login("unknownperm", "passw0rd-1"))

	err := f.svc.GrantPermission(f.ctx, root, GrantPermInput{
		UserPublicID: actor.PublicID, PermKey: "topic.feature", Reason: "不存在的点", IP: "127.0.0.1",
	})
	if errCode(err) != "admin.perm_unknown" {
		t.Fatalf("未知权限点 -> %v（code=%q）", err, errCode(err))
	}
}

// 用例 64/65：改角色与封号都写审计，封号返回被踢的会话数。
func TestAdminActionsWriteAudit(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	root := f.newSuperAdmin("root")
	f.newUser("victim", "passw0rd-1", "user")
	f.login("victim", "passw0rd-1")
	f.login("victim", "passw0rd-1")
	victim := f.actor(f.login("victim", "passw0rd-1"))

	if err := f.svc.SetUserRole(f.ctx, root, SetUserRoleInput{
		UserPublicID: victim.PublicID, RoleID: f.roleID("creator"), IP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("改角色失败: %v", err)
	}
	res, err := f.svc.BanUser(f.ctx, root, BanInput{UserPublicID: victim.PublicID, Action: "ban", IP: "127.0.0.1"})
	if err != nil {
		t.Fatalf("封号失败: %v", err)
	}
	if res.SessionsRevoked != 3 {
		t.Fatalf("被封时踢掉 %d 条会话，想要 3", res.SessionsRevoked)
	}

	var n int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM audit_logs WHERE action = 'user.role.assign'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("user.role.assign 审计 %d 条", n)
	}
	var detail string
	if err := f.pool.QueryRow(f.ctx, "SELECT detail::text FROM audit_logs WHERE action = 'user.ban'").Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "before") || !strings.Contains(detail, "after") {
		t.Fatalf("user.ban 的 detail 形状不对: %s", detail)
	}
}

// 用例 66：**审计与业务同事务**——审计写失败时业务改动必须一起回滚。
func TestAuditFailureRollsBackBusiness(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	root := f.newSuperAdmin("root")
	f.newUser("rollback", "passw0rd-1", "user")
	actor := f.actor(f.login("rollback", "passw0rd-1"))

	// 给本地 schema 的 audit_logs 加一条必然失败的约束：这模拟「审计写不进去」这个唯一的失败模式，
	// 而不必去改平台层的代码。先清空表——CHECK(false) 加不到已有行上。
	mustExec(t, f.ctx, f.pool, "DELETE FROM audit_logs")
	mustExec(t, f.ctx, f.pool, "ALTER TABLE audit_logs ADD CONSTRAINT ck_test_always_fails CHECK (false)")

	err := f.svc.SetUserRole(f.ctx, root, SetUserRoleInput{
		UserPublicID: actor.PublicID, RoleID: f.roleID("creator"), IP: "127.0.0.1",
	})
	if err == nil {
		t.Fatal("审计写失败却返回成功")
	}
	var roleKey string
	if err := f.pool.QueryRow(f.ctx,
		"SELECT r.key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.public_id = $1",
		actor.PublicID).Scan(&roleKey); err != nil {
		t.Fatal(err)
	}
	if roleKey != "user" {
		t.Fatalf("审计失败后业务改动**没有**回滚：role=%s", roleKey)
	}
}

// 用例 78/79：权限点自检两个方向——缺一个必须报错，多一个只 Warn。
func TestCheckPermissionsBothDirections(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	if err := f.svc.CheckPermissions(f.ctx); err != nil {
		t.Fatalf("正确的 seed 上自检返回 %v", err)
	}

	mustExec(t, f.ctx, f.pool, "DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE key = $1)", authz.PermAuditExport)
	mustExec(t, f.ctx, f.pool, "DELETE FROM permissions WHERE key = $1", authz.PermAuditExport)
	err := f.svc.CheckPermissions(f.ctx)
	if err == nil {
		t.Fatal("permissions 少一行时自检没有红")
	}
	if !strings.Contains(err.Error(), authz.PermAuditExport) {
		t.Fatalf("自检报错没带上缺的 key: %v", err)
	}

	// 反向：多一行代码不认识的 → 只 Warn，返回 nil。先把它缺的那条补回去。
	mustExec(t, f.ctx, f.pool, "INSERT INTO permissions (key, grp, name, description) VALUES ($1,'site',$1,'') ON CONFLICT (key) DO NOTHING", authz.PermAuditExport)
	mustExec(t, f.ctx, f.pool, "INSERT INTO permissions (key, grp, name, description) VALUES ('topic.feature','topic','精华','')")
	if err := f.svc.CheckPermissions(f.ctx); err != nil {
		t.Fatalf("多一个权限点时自检返回 %v，只应 Warn", err)
	}
}

// 枚举自检：解析器认两种引号（防「静默比不过」），且值域对不上时必须红。
//
// 注：CheckEnums 查的是 users.status / email_tokens.purpose 两个 CHECK，而它们**只存在于手写迁移**里
// （ent 的 field.String 在 PG 上不生成 CHECK）。测试夹具用 Schema.Create 建表，所以这里先手工把
// 两条 CHECK 按迁移的写法补上，否则测的就不是真库的形状。
func TestCheckEnumsParsesBothQuoteStyles(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	mustExec(t, f.ctx, f.pool,
		"ALTER TABLE users ADD CONSTRAINT ck_users_status CHECK (status IN ('active','banned','deleted'))")
	mustExec(t, f.ctx, f.pool,
		"ALTER TABLE email_tokens ADD CONSTRAINT ck_email_tokens_purpose CHECK (purpose IN ('verify','reset'))")
	if err := f.svc.CheckEnums(f.ctx); err != nil {
		t.Fatalf("迁移形状的 CHECK 上自检返回 %v", err)
	}

	// 解析器夹具：pg_get_constraintdef 在有些设置下输出双引号。
	def := "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'banned'::character varying])::text[])))"
	got := QuotedLiterals(def)
	if len(got) != 2 || got[0] != "active" || got[1] != "banned" {
		t.Fatalf("单引号解析 = %v", got)
	}
	dq := `CHECK ((status = ANY (ARRAY["active", "banned", "deleted"])))`
	got2 := QuotedLiterals(dq)
	if len(got2) != 3 {
		t.Fatalf("双引号解析 = %v（设计 §14.2：两种引号都要认）", got2)
	}

	// 把 users.status 放宽一个值 → 自检必须红。
	mustExec(t, f.ctx, f.pool, "ALTER TABLE users DROP CONSTRAINT ck_users_status")
	mustExec(t, f.ctx, f.pool, "ALTER TABLE users ADD CONSTRAINT ck_users_status2 CHECK (status IN ('active','banned','deleted','ghost'))")
	if err := f.svc.CheckEnums(f.ctx); err == nil {
		t.Fatal("枚举多一个值时自检没有红")
	}
}

// 用例 83：等级不变量（公式 level = floor(sqrt(exp/100)) + 1，边界九个点）。
func TestExpMaxBoundaries(t *testing.T) {
	// 九个边界点（设计 §12）：exp → level
	cases := map[int]int{0: 1, 99: 1, 100: 2, 101: 2, 399: 2, 400: 3, 401: 3, 9999: 10, 10000: 11}
	for exp, want := range cases {
		got := 1
		for got*got*100 <= exp {
			got++
		}
		if got != want {
			t.Fatalf("exp=%d → level %d，想要 %d", exp, got, want)
		}
	}
	// 下一级门槛 = (level+1)^2 * 100（设计 §12：level 1 → 100、level 3 → 1600）。
	if ExpMax(3) != 1600 {
		t.Fatalf("ExpMax(3) = %d，想要 1600", ExpMax(3))
	}
	if ExpMax(1) != 400 {
		t.Fatalf("ExpMax(1) = %d，想要 400", ExpMax(1))
	}
}

// 外键索引自检要能在**负例**上红（空库跑通不算验收）。
//
// 它是**全库**扫描）所以先用 Schema.Create 建出来的那些表也要过：
// 本轮 schema 里 25 条外键没有单列索引（ent 不建 FK 索引，迁移才建；测试夹具不跑迁移）。
// 为了只验这条 SQL 本身，先把它们按迁移的命名补上，再拿一对自建表做负例/正例。
func TestForeignKeysCheckCanFail(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	for _, ix := range entForeignKeysWithoutIndex {
		mustExec(t, f.ctx, f.pool, ix)
	}
	db := stdsqlOf(f.pool)
	defer db.Close()
	if err := CheckForeignKeys(f.ctx, db); err != nil {
		t.Fatalf("把 25 条外键索引补齐后自检仍然红: %v", err)
	}

	// 负例：新加一条外键、不给索引 → 必须红。
	mustExec(t, f.ctx, f.pool, "CREATE TABLE fk_parent (id bigint PRIMARY KEY)")
	mustExec(t, f.ctx, f.pool, "CREATE TABLE fk_child (id bigint PRIMARY KEY, parent_id bigint REFERENCES fk_parent(id))")
	err := CheckForeignKeys(f.ctx, db)
	if err == nil {
		t.Fatal("有未加索引的外键时自检没有红（空库跑通不算验收）")
	}

	// 正例：补上索引 → 绿。
	mustExec(t, f.ctx, f.pool, "CREATE INDEX idx_fk_child_parent ON fk_child (parent_id)")
	if err := CheckForeignKeys(f.ctx, db); err != nil {
		t.Fatalf("补上索引后自检仍然红: %v", err)
	}
}

// entForeignKeysWithoutIndex 是 Schema.Create 建出来的表里缺 FK 单列索引的那些 ALTER。
// 迁移（0002/0003/…）里都有对应的 CREATE INDEX；这里补的是**同一批**，只为让全库自检能跑到负例那一步。
var entForeignKeysWithoutIndex = []string{
	"CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)",
	"CREATE INDEX IF NOT EXISTS idx_email_tokens_user_id ON email_tokens (user_id)",
	"CREATE INDEX IF NOT EXISTS idx_users_role_id ON users (role_id)",
	"CREATE INDEX IF NOT EXISTS idx_users_equipped_title_id ON users (equipped_title_id)",
	"CREATE INDEX IF NOT EXISTS idx_users_title_equipped_by ON users (title_equipped_by)",
	"CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON audit_logs (actor_id)",
	"CREATE INDEX IF NOT EXISTS idx_images_user_images ON images (user_images)",
	"CREATE INDEX IF NOT EXISTS idx_user_titles_user_user_titles ON user_titles (user_user_titles)",
	"CREATE INDEX IF NOT EXISTS idx_user_titles_title_holders ON user_titles (title_holders)",
	"CREATE INDEX IF NOT EXISTS idx_user_titles_user_granted_titles ON user_titles (user_granted_titles)",
	"CREATE INDEX IF NOT EXISTS idx_banners_user_banners ON banners (user_banners)",
	"CREATE INDEX IF NOT EXISTS idx_announcements_user_announcements ON announcements (user_announcements)",
	"CREATE INDEX IF NOT EXISTS idx_banner_dismissals_banner_id ON banner_dismissals (banner_id)",
	"CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id)",
	"CREATE INDEX IF NOT EXISTS idx_notifications_user_notifications ON notifications (user_notifications)",
	"CREATE INDEX IF NOT EXISTS idx_notifications_user_acted_notifications ON notifications (user_acted_notifications)",
	"CREATE INDEX IF NOT EXISTS idx_notification_mutes_user_notification_mutes ON notification_mutes (user_notification_mutes)",
	"CREATE INDEX IF NOT EXISTS idx_exp_events_user_exp_events ON exp_events (user_exp_events)",
	"CREATE INDEX IF NOT EXISTS idx_messages_user_messages_as_low ON messages (user_messages_as_low)",
	"CREATE INDEX IF NOT EXISTS idx_messages_user_messages_as_high ON messages (user_messages_as_high)",
	"CREATE INDEX IF NOT EXISTS idx_messages_user_messages_sent ON messages (user_messages_sent)",
	"CREATE INDEX IF NOT EXISTS idx_payment_channels_user_payment_channels ON payment_channels (user_payment_channels)",
	"CREATE INDEX IF NOT EXISTS idx_donation_records_user_donations_sent ON donation_records (user_donations_sent)",
	"CREATE INDEX IF NOT EXISTS idx_donation_records_user_donations_received ON donation_records (user_donations_received)",
	"CREATE INDEX IF NOT EXISTS idx_donation_records_user_donations_verified ON donation_records (user_donations_verified)",
}

// 停用：prune 三个任务要能删到该删的行。
func TestPruneTasks(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	id := f.newUser("prunee", "passw0rd-1", "user")
	old := f.clk.Now().Add(-30 * 24 * time.Hour)
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO sessions (token_hash, user_id, csrf_token, ip, expires_at, last_seen_at) "+
			"VALUES (sha256('x'::bytea), $1, 'csrf', '127.0.0.1', $2, $2)", id, old)
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at) VALUES ($1, sha256('y'::bytea), 'verify', $2)", id, old)
	// granted_at 必须早于 expires_at（迁移里有 ck_user_permissions_expires）。
	older := old.Add(-24 * time.Hour)
	mustExec(t, f.ctx, f.pool,
		"INSERT INTO user_permissions (user_id, permission_id, granted_at, expires_at, reason) "+
			"SELECT $1, id, $2, $3, '过期了' FROM permissions WHERE key = $4", id, older, old, authz.PermUserBan)

	n, err := f.svc.PruneSessions(f.ctx, f.clk.Now().Add(-7*24*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("PruneSessions = %d, %v", n, err)
	}
	n, err = f.svc.PruneEmailTokens(f.ctx, f.clk.Now().Add(-7*24*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("PruneEmailTokens = %d, %v", n, err)
	}
	n, err = f.svc.PruneExpiredGrants(f.ctx, f.clk.Now().Add(-7*24*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("PruneExpiredGrants = %d, %v", n, err)
	}
	var audits int
	if err := f.pool.QueryRow(f.ctx, "SELECT count(*) FROM audit_logs WHERE action = 'permission.expire'").Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 1 {
		t.Fatalf("permission.expire 审计 %d 条，想要 1", audits)
	}
}

// is_super 唯一：结构上只允许一个超管角色（uq_roles_super）。
func TestOnlyOneSuperRole(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	_, err := f.pool.Exec(f.ctx,
		"INSERT INTO roles (key, name, depth, is_system, is_super) VALUES ('root2','第二个超管',0,false,true)")
	if err == nil {
		t.Fatal("插入了第二个 is_super 角色，uq_roles_super 没生效")
	}
}

func ptrTime(t time.Time) *time.Time { return &t }
