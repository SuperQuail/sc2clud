package forum

import (
	"strings"
	"testing"
	"time"

	"forum/internal/authz"
)

// 组授判定（D38 拍板的四条语义）：① 组授是加法授权；② 显式 deny 终局；
// ③ superadmin 照旧；④ 禁言 / 等级门槛的顺序照现状。组行写在 board_group_acls，
// 既有 board_acls 一行不动 —— 本文件只测「合流之后的行为」。

// setGroupACL 写一行分区 × 组的 ACL（形状照 harness 的 setACL）。
func (h *harness) setGroupACL(boardID, groupID int64, can, deny bool, action string) {
	h.t.Helper()
	post, reply := action == "post", action == "reply"
	_, err := h.pool.Exec(h.ctx, `INSERT INTO board_group_acls
	(board_id, group_id, can_post, can_reply, deny_post, deny_reply)
	VALUES ($1, $2, $3, $4, $5, $6)`,
		boardID, groupID, can && post, can && reply, deny && post, deny && reply)
	if err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) addMember(groupID, userID int64) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO user_group_members (group_id, user_id) VALUES ($1, $2)", groupID, userID); err != nil {
		h.t.Fatal(err)
	}
}

// seedGroup 建一个组（管理端写路径落地前，判定的预备数据用它建）。
func (h *harness) seedGroup(key string) int64 {
	h.t.Helper()
	var id int64
	err := h.pool.QueryRow(h.ctx, `INSERT INTO user_groups (key, name) VALUES ($1, $1) RETURNING id`, key).Scan(&id)
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func TestGroupAclAdditive(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	super := h.seedRole("superadmin", true)
	member := h.seedUser("ginny", role, 5, false)
	outsider := h.seedUser("horace", role, 5, false)
	gid := h.seedGroup("va")
	boardID := h.seedBoard("gated", 0, true)
	h.setGroupACL(boardID, gid, true, false, "post")
	h.addMember(gid, member)

	// ① 加法授权：成员可发（基线角色那一行**不存在** —— 组路径是白名单里多出来的一条）
	if err := h.svc.canSpeak(h.ctx, h.actor(member, role, authz.PermTopicCreate), boardID, "post"); err != nil {
		t.Fatalf("组授后成员应当可发: %v", err)
	}
	// 非成员不可发（白名单制不变）
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(outsider, role, authz.PermTopicCreate), boardID, "post"),
		"board.acl_denied")
	// ③ 超管照旧短路：不在组里、也没有角色行，仍然放行
	if err := h.svc.canSpeak(h.ctx, h.super(outsider, super), boardID, "post"); err != nil {
		t.Fatalf("超管应当照旧放行: %v", err)
	}
}

func TestGroupAclDenyWins(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	sally := h.seedUser("sally", role, 5, false)
	gid := h.seedGroup("vb")
	boardID := h.seedBoard("d1", 0, true)
	// 组 deny 是显式终局
	h.setGroupACL(boardID, gid, false, true, "post")
	h.addMember(gid, sally)
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(sally, role, authz.PermTopicCreate), boardID, "post"),
		"board.acl_denied")

	// 角色行 can + 组 deny → 仍 deny（② 任一层 deny 终局）
	board2 := h.seedBoard("d2", 0, true)
	creator := h.seedRole("creator", false)
	pete := h.seedUser("pete", creator, 5, false)
	g2 := h.seedGroup("gc")
	h.setACL(board2, creator, true, false, "post")
	h.setGroupACL(board2, g2, false, true, "post")
	h.addMember(g2, pete)
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(pete, creator, authz.PermTopicCreate), board2, "post"),
		"board.acl_denied")

	// 反向：角色行 deny + 组 can → deny 同样终局
	board3 := h.seedBoard("d3", 0, true)
	g3 := h.seedGroup("gd")
	h.setACL(board3, creator, false, true, "post")
	h.setGroupACL(board3, g3, true, false, "post")
	h.addMember(g3, pete)
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(pete, creator, authz.PermTopicCreate), board3, "post"),
		"board.acl_denied")
}

func TestGroupAclLevelGateKept(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	gid := h.seedGroup("ve")
	boardID := h.seedBoardReply("leveled", 5, 5, true)
	h.setGroupACL(boardID, gid, true, false, "post")
	low := h.seedUser("low", role, 2, false)
	h.addMember(gid, low)
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(low, role, authz.PermTopicCreate), boardID, "post"),
		"forum.level_too_low")

	// acl_enabled=false：整块 ACL（含组）都不生效 —— 第 3 步直接放行（④ 顺序照现状）。
	open := h.seedBoard("open0", 0, false)
	h.setGroupACL(open, gid, false, true, "post")
	low2 := h.seedUser("low2", role, 2, false)
	h.addMember(gid, low2)
	if err := h.svc.canSpeak(h.ctx, h.actor(low2, role, authz.PermTopicCreate), open, "post"); err != nil {
		t.Fatalf("acl_enabled=false 时组也不该拦: %v", err)
	}
}

func TestGroupAclRemovalTakesEffectImmediately(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	gid := h.seedGroup("vf")
	boardID := h.seedBoard("rm", 0, true)
	h.setGroupACL(boardID, gid, true, false, "post")
	uid := h.seedUser("morrie", role, 5, false)
	h.addMember(gid, uid)
	act := h.actor(uid, role, authz.PermTopicCreate)
	if err := h.svc.canSpeak(h.ctx, act, boardID, "post"); err != nil {
		t.Fatalf("入组后应当可发: %v", err)
	}
	if _, err := h.pool.Exec(h.ctx,
		"DELETE FROM user_group_members WHERE group_id = $1 AND user_id = $2", gid, uid); err != nil {
		t.Fatal(err)
	}
	assertCode(t, h.svc.canSpeak(h.ctx, act, boardID, "post"), "board.acl_denied")

	// 删组同样立即生效：路径（组行）随组级联删光，白名单恢复原状。
	uid2 := h.seedUser("morrie2", role, 5, false)
	h.addMember(gid, uid2)
	state2 := h.actor(uid2, role, authz.PermTopicCreate)
	if err := h.svc.canSpeak(h.ctx, state2, boardID, "post"); err != nil {
		t.Fatalf("重新入组应当可发: %v", err)
	}
	if _, err := h.pool.Exec(h.ctx, "DELETE FROM user_groups WHERE id = $1", gid); err != nil {
		t.Fatal(err)
	}
	assertCode(t, h.svc.canSpeak(h.ctx, state2, boardID, "post"),
		"board.acl_denied")
}

func TestGroupAclSanctionFirst(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	gid := h.seedGroup("vg")
	boardID := h.seedBoard("sn", 0, true)
	h.setGroupACL(boardID, gid, true, false, "post")
	uid := h.seedUser("flint", role, 5, false)
	h.addMember(gid, uid)
	h.sanction(uid, nil, "all", ptrTime(h.clk.Now().Add(time.Hour)))
	assertCode(t, h.svc.canSpeak(h.ctx, h.actor(uid, role, authz.PermTopicCreate), boardID, "post"),
		"forum.sanctioned")
}

// 组白名单的**拒绝消息要可读**（派单：同一码 board.acl_denied 把「为什么不许」说清楚，不发新码）。
func TestGroupAclReadableRefusal(t *testing.T) {
	h := newHarness(t)
	role := h.seedRole("user", false)
	gid := h.seedGroup("vh")
	boardID := h.seedBoard("msg", 0, true)
	h.setGroupACL(boardID, gid, true, false, "post")
	uid := h.seedUser("neville", role, 5, false)
	err := h.svc.canSpeak(h.ctx, h.actor(uid, role, authz.PermTopicCreate), boardID, "post")
	assertCode(t, err, "board.acl_denied")
	if msg := mustAppErr(t, err).Msg; !strings.Contains(msg, "用户组") {
		t.Fatalf("组白名单拒绝时应给出可读说明，实际 %q", msg)
	}
}
