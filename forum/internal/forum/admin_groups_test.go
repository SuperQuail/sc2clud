package forum

import (
	"testing"

	"forum/internal/authz"
)

// 用户组管理（D38）的用例。判定语义的先红后绿在 group_acl_test.go；
// 本文件钉住管理端 CRUD / 组员 / 组矩阵的契约与审计。

// groupAdmin 造一个持 user.ban 的身份（组与组员的闸）。
func (h *harness) groupAdmin(userID, roleID int64) *authz.Actor {
	return h.actor(userID, roleID, authz.PermUserBan)
}

func TestAdminGroupsGuards(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	plain := h.actor(h.seedUser("plain", roleID, 1, false), roleID)

	if _, err := h.svc.AdminListGroups(h.ctx, nil); err == nil {
		t.Fatal("游客必须被拒")
	}
	for _, call := range []func() error{
		func() error { _, err := h.svc.AdminListGroups(h.ctx, plain); return err },
		func() error { _, err := h.svc.AdminCreateGroup(h.ctx, plain, CreateGroupInput{Key: "x", Name: "X"}); return err },
		func() error { _, err := h.svc.AdminUpdateGroup(h.ctx, plain, "00000000-0000-0000-0000-000000000000", UpdateGroupInput{}); return err },
		func() error { return h.svc.AdminDeleteGroup(h.ctx, plain, "00000000-0000-0000-0000-000000000000") },
		func() error { _, err := h.svc.AdminGroupMembers(h.ctx, plain, "00000000-0000-0000-0000-000000000000"); return err },
	} {
		assertCode(t, call(), "common.forbidden")
	}
}

func TestAdminGroupCRUD(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	admin := h.groupAdmin(h.seedUser("mod", roleID, 1, false), roleID)

	// 两组身份的分工：组这条线要 user.ban，board.manage 不顶事（分区管理矩阵那条才有 board.manage）。
	boardAdmin := h.boardAdmin(h.seedUser("board", roleID, 1, false), roleID)
	if _, err := h.svc.AdminCreateGroup(h.ctx, boardAdmin, CreateGroupInput{Key: "va", Name: "N"}); err == nil {
		t.Fatal("只有 user.ban 能建组（board.manage 不进这扇门）")
	}

	g, err := h.svc.AdminCreateGroup(h.ctx, admin, CreateGroupInput{Key: "va", Name: "视觉组", Description: "d1"})
	if err != nil {
		t.Fatal(err)
	}
	if g.ID == "" || g.Key != "va" || g.Name != "视觉组" || g.MemberCount != 0 {
		t.Fatalf("新建组的形状不对: %+v", g)
	}
	// 撞 key 400；非法 key 400
	if _, err := h.svc.AdminCreateGroup(h.ctx, admin, CreateGroupInput{Key: "va", Name: "N"}); err == nil {
		t.Fatal("重复 key 必须被拒")
	}
	for _, bad := range []string{"", "A", "Bad Slug", "中文"} {
		if _, err := h.svc.AdminCreateGroup(h.ctx, admin, CreateGroupInput{Key: bad, Name: "N"}); err == nil {
			t.Fatalf("key %q 必须被拒", bad)
		}
	}

	n2 := "视觉组 2"
	d2 := "改过的简介"
	up, err := h.svc.AdminUpdateGroup(h.ctx, admin, g.ID, UpdateGroupInput{Name: &n2, Description: &d2})
	if err != nil {
		t.Fatal(err)
	}
	if up.Name != "视觉组 2" || up.Description != "改过的简介" || up.Key != "va" {
		t.Fatalf("只该改给了的字段，key 不该动: %+v", up)
	}
	if _, err := h.svc.AdminUpdateGroup(h.ctx, admin, g.ID, UpdateGroupInput{}); err == nil {
		t.Fatal("没有要改的字段必须报参数错误")
	}

	// 审计：建 / 改各一条
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditGroupCreate); n != 1 {
		t.Fatalf("建组应当有 1 行审计（target_type=user_group），实际 %d", n)
	}
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditGroupUpdate); n != 1 {
		t.Fatalf("改组应当有 1 行审计，实际 %d", n)
	}

	// 不存在 / 非 uuid → 404
	if err := h.svc.AdminDeleteGroup(h.ctx, admin, "00000000-0000-0000-0000-000000000000"); err == nil {
		t.Fatal("不存在的组必须报错")
	}
	if err := h.svc.AdminDeleteGroup(h.ctx, admin, "not-a-uuid"); err == nil {
		t.Fatal("非 uuid 必须报错")
	}

	// 删组：成员与组行随 CASCADE
	gid := h.seedGroup("vb")
	uid := h.seedUser("m1", roleID, 1, false)
	h.addMember(gid, uid)
	if err := h.svc.AdminDeleteGroup(h.ctx, admin, h.groupPublicID(gid)); err != nil {
		t.Fatal(err)
	}
	if n := h.countRows(t, "SELECT count(*) FROM user_group_members WHERE group_id = $1", gid); n != 0 {
		t.Fatalf("删组后成员应当随之清空，实际 %d", n)
	}
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditGroupDelete); n != 1 {
		t.Fatal("删组应当留审计")
	}
}

func TestAdminGroupMembers(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	admin := h.groupAdmin(h.seedUser("mod", roleID, 1, false), roleID)
	gid := h.seedGroup("vg")
	pub := h.groupPublicID(gid)
	u1 := h.seedUser("alice", roleID, 1, false)
	u2 := h.seedUser("bob", roleID, 1, false)

	if _, err := h.svc.AdminAddGroupMember(h.ctx, admin, pub, "not-a-uuid"); err == nil {
		t.Fatal("非 uuid 用户必须报错")
	}
	if _, err := h.svc.AdminAddGroupMember(h.ctx, admin, pub, "00000000-0000-0000-0000-099999999999"); err == nil {
		t.Fatal("不存在的用户必须报错")
	}
	items, err := h.svc.AdminAddGroupMember(h.ctx, admin, pub, h.userPublicID(u1))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Handle != "alice" {
		t.Fatalf("入组后的名单不对: %+v", items)
	}

	// 重复入组 400（挂 user_id）
	if _, err := h.svc.AdminAddGroupMember(h.ctx, admin, pub, h.userPublicID(u1)); err == nil {
		t.Fatal("重复入组必须被拒")
	}

	if _, err := h.svc.AdminAddGroupMember(h.ctx, admin, pub, h.userPublicID(u2)); err != nil {
		t.Fatal(err)
	}
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditGroupMemberAdd); n != 2 {
		t.Fatalf("两次入组应当有 2 行审计，实际 %d", n)
	}

	// 移出：名单回执跟着少一个；再次移出 = 404（管理员多半点错行）
	items, err = h.svc.AdminRemoveGroupMember(h.ctx, admin, pub, h.userPublicID(u1))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Handle != "bob" {
		t.Fatalf("移出后的名单不对: %+v", items)
	}
	// 再次移出 = 404 group.member_not_found（不是「操作成功」）
	assertCode(t, h.svcErr(t, admin, pub, u1), "group.member_not_found")

	// 管理端动作与判定同源：service 拉人入组后，该用户立刻可以说话（直查名单，无缓存）
	boardID := h.seedBoard("mgated", 0, true)
	h.setGroupACL(boardID, gid, true, false, "post")
	uid := h.seedUser("carl", roleID, 5, false)
	if _, err := h.svc.AdminAddGroupMember(h.ctx, admin, h.groupPublicID(gid), h.userPublicID(uid)); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.canSpeak(h.ctx, h.actor(uid, roleID, authz.PermTopicCreate), boardID, "post"); err != nil {
		t.Fatalf("管理端加组员应当立刻生效: %v", err)
	}
	if _, err := h.svc.AdminRemoveGroupMember(h.ctx, admin, h.groupPublicID(gid), h.userPublicID(uid)); err != nil {
		t.Fatal(err)
	}
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(uid, roleID, authz.PermTopicCreate), boardID, "post"),
		"board.acl_denied")
}

func TestAdminBoardGroupACL(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	admin := h.boardAdmin(h.seedUser("mod", roleID, 1, false), roleID)
	h.seedGroup("va")
	h.seedGroup("vb")
	boardID := h.seedBoard("ga", 0, false)
	pub := h.boardPublicID(boardID)

	// board.manage 与组目录两把闸是分开的：user.ban 不能动分区的矩阵
	if _, err := h.svc.ReplaceBoardGroupACL(h.ctx, h.groupAdmin(h.seedUser("g", roleID, 1, false), roleID), pub, nil); err == nil {
		t.Fatal("组矩阵要走 board.manage，user.ban 不顶事")
	}

	items, err := h.svc.ReplaceBoardGroupACL(h.ctx, admin, pub, []AdminGroupACLItem{
		{GroupKey: "va", CanPost: true},
		{GroupKey: "vb", DenyReply: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].GroupKey != "va" || !items[0].CanPost || !items[1].DenyReply {
		t.Fatalf("回执的组矩阵不对: %+v", items)
	}

	// 三处不静默：矛盾 / 重复 / 组不存在
	assertCode(t, mustFail(t, func() error {
		_, err := h.svc.ReplaceBoardGroupACL(h.ctx, admin, pub, []AdminGroupACLItem{{GroupKey: "va", CanPost: true, DenyPost: true}})
		return err
	}), "common.invalid_input")
	assertCode(t, mustFail(t, func() error {
		_, err := h.svc.ReplaceBoardGroupACL(h.ctx, admin, pub, []AdminGroupACLItem{{GroupKey: "va", CanPost: true}, {GroupKey: "va"}})
		return err
	}), "common.invalid_input")
	assertCode(t, mustFail(t, func() error {
		_, err := h.svc.ReplaceBoardGroupACL(h.ctx, admin, pub, []AdminGroupACLItem{{GroupKey: "ghost"}})
		return err
	}), "common.invalid_input")

	// 全量替换：少给一行就真删掉
	if _, err := h.svc.ReplaceBoardGroupACL(h.ctx, admin, pub, []AdminGroupACLItem{{GroupKey: "vb", CanReply: true}}); err != nil {
		t.Fatal(err)
	}
	if n := h.countRows(t, "SELECT count(*) FROM board_group_acls WHERE board_id = $1", boardID); n != 1 {
		t.Fatalf("全量替换后应当只剩 1 行，实际 %d", n)
	}

	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditBoardGroupACLUpdate); n != 2 {
		t.Fatalf("两次成功替换应当有 2 行审计，实际 %d", n)
	}
}

// ── 小工具 ───────────────────────────────────────────────────────

func (h *harness) groupPublicID(id int64) string {
	h.t.Helper()
	var pub string
	if err := h.pool.QueryRow(h.ctx, "SELECT public_id::text FROM user_groups WHERE id = $1", id).Scan(&pub); err != nil {
		h.t.Fatal(err)
	}
	return pub
}

func (h *harness) userPublicID(id int64) string {
	h.t.Helper()
	var pub string
	if err := h.pool.QueryRow(h.ctx, "SELECT public_id::text FROM users WHERE id = $1", id).Scan(&pub); err != nil {
		h.t.Fatal(err)
	}
	return pub
}

func mustFail(t *testing.T, fn func() error) error {
	t.Helper()
	return fn()
}

// svcErr 供一个「期望 404 但先拿到了别的」的二次断言（不额外包一层口径）。
func (h *harness) svcErr(t *testing.T, a *authz.Actor, groupPublicID string, u int64) error {
	_, err := h.svc.AdminRemoveGroupMember(h.ctx, a, groupPublicID, h.userPublicID(u))
	return err
}