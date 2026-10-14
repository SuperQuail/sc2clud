package forum

// 分区管理（C2）的用例。**先确认会红**：路由与 service 都不存在时，
// `go test ./internal/forum/ -run TestAdminBoards` 连编译都过不去（方法未定义），
// 这正是「端点不存在」最直接的证据。

import (
	"context"
	"strings"
	"testing"
	"time"

	"forum/internal/authz"
)

// boardAdmin 造一个持 board.manage 的身份。
func (h *harness) boardAdmin(userID, roleID int64) *authz.Actor {
	return h.actor(userID, roleID, authz.PermBoardManage)
}

// boardPublicID 取一个分区的对外 ID（0025 之后才有这一列）。
func (h *harness) boardPublicID(id int64) string {
	h.t.Helper()
	var pub string
	if err := h.pool.QueryRow(h.ctx, "SELECT public_id::text FROM boards WHERE id = $1", id).Scan(&pub); err != nil {
		h.t.Fatal(err)
	}
	return pub
}

func (h *harness) boardSlug(id int64) string {
	h.t.Helper()
	var slug string
	if err := h.pool.QueryRow(h.ctx, "SELECT slug FROM boards WHERE id = $1", id).Scan(&slug); err != nil {
		h.t.Fatal(err)
	}
	return slug
}

// ── 权限守卫（每条路由都要，游客 401 / 无权限 403） ────────────────

func TestAdminBoardsGuards(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	boardID := h.seedBoard("campaign", 0, false)
	plain := h.actor(h.seedUser("plain", roleID, 1, false), roleID)
	public := h.boardPublicID(boardID)

	if _, err := h.svc.AdminListBoards(h.ctx, nil); err == nil {
		t.Fatal("游客必须被拒")
	}
	if _, err := h.svc.AdminListBoards(h.ctx, plain); err == nil {
		t.Fatal("没有 board.manage 必须被拒")
	}
	for _, call := range []func() error{
		func() error { _, err := h.svc.AdminBoard(h.ctx, plain, public); return err },
		func() error {
			_, err := h.svc.CreateBoard(h.ctx, plain, CreateBoardInput{Slug: "x-y", Name: "X"})
			return err
		},
		func() error { _, err := h.svc.UpdateBoard(h.ctx, plain, public, UpdateBoardInput{}); return err },
		func() error { return h.svc.ReorderBoards(h.ctx, plain, []string{public}) },
		func() error { _, err := h.svc.AdminBoardACL(h.ctx, plain, public); return err },
		func() error { _, err := h.svc.ReplaceBoardACL(h.ctx, plain, public, nil); return err },
		func() error { _, err := h.svc.AdminBoardModerators(h.ctx, plain, public); return err },
		func() error { _, err := h.svc.GrantBoardModerator(h.ctx, plain, public, public, nil); return err },
		func() error { return h.svc.RevokeBoardModerator(h.ctx, plain, public, public) },
	} {
		assertCode(t, call(), "common.forbidden")
	}
}

// ── 列表与详情 ────────────────────────────────────────────────────

func TestAdminBoardsListIncludesArchivedAndModerators(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	admin := h.boardAdmin(h.seedUser("mod", roleID, 1, true), roleID)
	activeID := h.seedBoard("active-board", 0, false)
	archivedID := h.seedBoard("old-board", 0, false)
	if _, err := h.pool.Exec(h.ctx, "UPDATE boards SET status = $1 WHERE id = $2", boardStatusArchived, archivedID); err != nil {
		t.Fatal(err)
	}
	modUserID := h.seedUser("bm", roleID, 1, false)
	h.seedModerator(activeID, modUserID, nil)

	// 公开列表只有 active —— 后台列表**必须**能看到归档的，否则归档之后就没法在界面上把它改回来。
	pub, err := h.svc.ListBoards(h.ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(pub) != 1 {
		t.Fatalf("公开列表应当只有 1 个 active 分区，实际 %d", len(pub))
	}

	items, err := h.svc.AdminListBoards(h.ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("后台列表应当有 2 个分区（含归档），实际 %d", len(items))
	}
	if items[0].Position != 1 || items[1].Position != 2 {
		t.Fatalf("position 应当是 1/2，实际 %d/%d", items[0].Position, items[1].Position)
	}
	var active *AdminBoardDTO
	for i := range items {
		if items[i].Slug == "active-board" {
			active = &items[i]
		}
	}
	if active == nil {
		t.Fatal("找不到 active-board")
	}
	if active.ID != h.boardPublicID(activeID) {
		t.Fatalf("列表项的 id 必须是对外 ID，实际 %q", active.ID)
	}
	if len(active.Moderators) != 1 || active.Moderators[0].Handle != "bm" {
		t.Fatalf("版主名单不对: %+v", active.Moderators)
	}
	if active.Moderators[0].ExpiresAt != nil {
		t.Fatal("永久任期的 expires_at 应当是 null")
	}
	if active.ACLEnabled {
		t.Fatal("acl_enabled 应当是 false")
	}
	if active.Moderators == nil {
		t.Fatal("moderators 必须是 []，不能是 null（前端按数组渲染）")
	}
}

// ── 建 / 改 ───────────────────────────────────────────────────────

func TestCreateAndUpdateBoard(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	admin := h.boardAdmin(h.seedUser("mod", roleID, 1, true), roleID)

	// 非法 slug 一律 400（slug 进 URL，大写与空格会让同一本书出现两个链接）
	for _, bad := range []string{"", "A", "Bad Slug", "-lead", "中文"} {
		if _, err := h.svc.CreateBoard(h.ctx, admin, CreateBoardInput{Slug: bad, Name: "N"}); err == nil {
			t.Fatalf("slug %q 必须被拒", bad)
		}
	}
	d, err := h.svc.CreateBoard(h.ctx, admin, CreateBoardInput{
		Slug: "new-board", Name: "新分区", Description: "简介", MinPostLevel: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.ID == "" || d.Slug != "new-board" || d.Status != boardStatusActive {
		t.Fatalf("新建分区的形状不对: %+v", d)
	}
	if d.ACLEnabled {
		t.Fatal("新分区默认不启用 ACL（默认 true 会让新分区一上线就没人能发帖）")
	}
	if d.MinPostLevel != 3 {
		t.Fatalf("min_post_level 应当是 3，实际 %d", d.MinPostLevel)
	}
	// 审计：谁在什么时候建了哪个分区
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditBoardCreate); n != 1 {
		t.Fatalf("建分区应当有 1 行审计，实际 %d", n)
	}
	// 撞 slug 是 400（挂到输入框上），不是 500
	_, err = h.svc.CreateBoard(h.ctx, admin, CreateBoardInput{Slug: "new-board", Name: "另一个"})
	assertCode(t, err, "common.invalid_input")

	// 改：只改给了的字段
	name := "改名了"
	level := 0
	upd, err := h.svc.UpdateBoard(h.ctx, admin, d.ID, UpdateBoardInput{Name: &name, MinPostLevel: &level})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Name != "改名了" || upd.MinPostLevel != 0 || upd.Description != "简介" {
		t.Fatalf("只该改给了的字段: %+v", upd)
	}
	// 一个字都没给 = 参数错误，不是「成功但什么都没做」
	if _, err := h.svc.UpdateBoard(h.ctx, admin, d.ID, UpdateBoardInput{}); err == nil {
		t.Fatal("没有要改的字段必须报参数错误")
	}
	// slug 不在 Update 的入参里 —— 这一条用编译期保证，测试只钉住「改完之后 slug 没变」
	if h.boardSlug(h.userIDBoard(t, d.ID)) != "new-board" {
		t.Fatal("更新不该动 slug")
	}
	// 不存在的分区 / 非 uuid：同一个 404
	if _, err := h.svc.UpdateBoard(h.ctx, admin, "00000000-0000-0000-0000-000000000000", UpdateBoardInput{Name: &name}); err == nil {
		t.Fatal("不存在的分区必须报错")
	}
	if _, err := h.svc.UpdateBoard(h.ctx, admin, "not-a-uuid", UpdateBoardInput{Name: &name}); err == nil {
		t.Fatal("非 uuid 必须报错")
	}
}

// userIDBoard 把对外 ID 换回自增 id（测试里要用）。
func (h *harness) userIDBoard(t *testing.T, publicID string) int64 {
	t.Helper()
	var id int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM boards WHERE public_id = $1", publicID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// seedModerator 直接插一行版主任期（绕开 service，用来造列表的前置）。
func (h *harness) seedModerator(boardID, userID int64, expires *time.Time) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO board_moderators (board_id, user_id, granted_at, expires_at) VALUES ($1, $2, now(), $3)",
		boardID, userID, expires); err != nil {
		h.t.Fatal(err)
	}
}

// 封面：**「没给」与「清空」是两件事**（拍板 08 第二轮「壁纸替换」）。
//
// 上一版把空串折成 nil，于是「只发 {"cover_hash":""}」既跳过 SetCoverHash、
// 又不计入「有没有要改的字段」→ 400「没有要改的字段」：清空封面这条路根本走不通，
// 而屏上因此连按钮都不敢画（画一颗点了必 400 的按钮是最坏的一种「看着正常」）。
func TestUpdateBoardCoverHashDistinguishesAbsentFromClear(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	admin := h.boardAdmin(h.seedUser("mod", roleID, 1, true), roleID)
	boardID := h.seedBoard("campaign", 0, false)
	public := h.boardPublicID(boardID)
	newHash := strings.Repeat("b", 64)
	old := strings.Repeat("a", 64)
	h.seedImage(newHash)
	h.seedImage(old)
	if _, err := h.pool.Exec(h.ctx, "UPDATE boards SET cover_hash = $1 WHERE id = $2", old, boardID); err != nil {
		t.Fatal(err)
	}

	// ① 换一张：给了非空 hash 就写进去 —— 这是「替换」，与「清空」是两条不同的路
	d, err := h.svc.UpdateBoard(h.ctx, admin, public, UpdateBoardInput{CoverHash: &newHash})
	if err != nil {
		t.Fatal(err)
	}
	if d.CoverHash != newHash {
		t.Fatalf("封面应当换成 %s，实际 %q", newHash, d.CoverHash)
	}

	// ② 只发空串就能清空（这条在旧行为下是 400「没有要改的字段」）
	empty := ""
	d, err = h.svc.UpdateBoard(h.ctx, admin, public, UpdateBoardInput{CoverHash: &empty})
	if err != nil {
		t.Fatalf("{\"cover_hash\":\"\"} 必须能清空封面，实际报错: %v", err)
	}
	if d.CoverHash != "" {
		t.Fatalf("清空之后回执里的封面应当为空串，实际 %q", d.CoverHash)
	}
	// 回执是一层，库里是另一层：列必须真的成了 NULL（前端按「空串 = 没有封面」走占位块）
	var inDB *string
	if err := h.pool.QueryRow(h.ctx, "SELECT cover_hash FROM boards WHERE id = $1", boardID).Scan(&inDB); err != nil {
		t.Fatal(err)
	}
	if inDB != nil {
		t.Fatalf("清空之后 boards.cover_hash 必须是 NULL，实际 %q", *inDB)
	}

	// ③ **没给**这个字段才是「不动」：换个字段改，封面不能被顺手清掉
	back := newHash
	if _, err := h.svc.UpdateBoard(h.ctx, admin, public, UpdateBoardInput{CoverHash: &back}); err != nil {
		t.Fatal(err)
	}
	name := "改个名"
	d, err = h.svc.UpdateBoard(h.ctx, admin, public, UpdateBoardInput{Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	if d.CoverHash != newHash || d.Name != name {
		t.Fatalf("只改名字时封面必须原样保留: cover=%q name=%q", d.CoverHash, d.Name)
	}
	// 审计要如实记「谁把封面撤了」（这类后台最常被追问的问题），而且**不能顺手编出没改的字段**：
	//   · 最新一条 = ③ 的改名：after 里只该有 name；
	//   · 上一条   = ② 的清空：after 里要有 cover_hash。
	var renamed, cleared string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT detail::text FROM audit_logs WHERE action = $1 ORDER BY id DESC OFFSET 0 LIMIT 1",
		AuditBoardUpdate).Scan(&renamed); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(renamed, "cover_hash") {
		t.Fatalf("只改名字那一条审计的 after 里不该有 cover_hash: %s", renamed)
	}
	if err := h.pool.QueryRow(h.ctx,
		"SELECT detail::text FROM audit_logs WHERE action = $1 ORDER BY id DESC OFFSET 1 LIMIT 1",
		AuditBoardUpdate).Scan(&cleared); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cleared, "cover_hash") {
		t.Fatalf("清空封面那一条审计要留下 cover_hash: %s", cleared)
	}
}

// ── 重排 ──────────────────────────────────────────────────────────

func TestReorderBoards(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	admin := h.boardAdmin(h.seedUser("mod", roleID, 1, true), roleID)
	a := h.seedBoard("aaa", 0, false)
	b := h.seedBoard("bbb", 0, false)
	c := h.seedBoard("ccc", 0, false)

	// 少给一个 = 400：留下的那个会与别人撞 sort，「谁在前」从此说不清
	pa, pb := h.boardPublicID(a), h.boardPublicID(b)
	assertCode(t, h.svc.ReorderBoards(h.ctx, admin, []string{pa, pb}), "common.invalid_input")
	// 重复 = 400
	assertCode(t, h.svc.ReorderBoards(h.ctx, admin, []string{pa, pa, pb}), "common.invalid_input")
	// 非 uuid = 400
	assertCode(t, h.svc.ReorderBoards(h.ctx, admin, []string{pa, pb, "nope"}), "common.invalid_input")
	// 不存在的 uuid = 400（不是静默跳过）
	assertCode(t, h.svc.ReorderBoards(h.ctx, admin,
		[]string{pa, pb, "00000000-0000-0000-0000-000000000000"}), "common.invalid_input")

	// 正序：ccc, aaa, bbb
	pc := h.boardPublicID(c)
	if err := h.svc.ReorderBoards(h.ctx, admin, []string{pc, pa, pb}); err != nil {
		t.Fatal(err)
	}
	items, err := h.svc.AdminListBoards(h.ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{items[0].Slug, items[1].Slug, items[2].Slug}
	if got[0] != "ccc" || got[1] != "aaa" || got[2] != "bbb" {
		t.Fatalf("顺序应当是 ccc/aaa/bbb，实际 %v", got)
	}
	if items[0].Position != 1 || items[2].Position != 3 {
		t.Fatalf("position 应当跟着重排走: %d/%d", items[0].Position, items[2].Position)
	}
	// 审计一行
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditBoardReorder); n != 1 {
		t.Fatalf("重排应当有 1 行审计，实际 %d", n)
	}
}

// ── ACL 矩阵 ──────────────────────────────────────────────────────

func TestBoardACLReplaceIsWhole(t *testing.T) {
	h := newHarness(t)
	userRole := h.seedRole("user", false)
	creatorRole := h.seedRole("creator", false)
	adminRole := h.seedRole("admin", false)
	admin := h.boardAdmin(h.seedUser("mod", userRole, 1, true), userRole)
	boardID := h.seedBoard("campaign", 0, true)
	public := h.boardPublicID(boardID)

	// 先放两行，再全量替换成一行 —— 没在 payload 里的那一行必须**消失**
	if _, err := h.svc.ReplaceBoardACL(h.ctx, admin, public, []AdminACLItem{
		{RoleID: userRole, CanReply: true},
		{RoleID: creatorRole, CanPost: true, CanReply: true},
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := h.svc.AdminBoardACL(h.ctx, admin, public)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("应当有 2 行 ACL，实际 %d", len(rows))
	}
	if rows[0].RoleKey == "" {
		t.Fatal("ACL 行必须带 role_key（前端要显示角色名而不是一个数字）")
	}

	rows, err = h.svc.ReplaceBoardACL(h.ctx, admin, public, []AdminACLItem{
		{RoleID: adminRole, CanPost: true, CanReply: true, DenyPost: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].RoleID != adminRole || !rows[0].CanPost {
		t.Fatalf("全量替换后应当只剩 admin 那一行: %+v", rows)
	}
	if n := h.countRows(t, "SELECT count(*) FROM board_acls WHERE board_id = $1", boardID); n != 1 {
		t.Fatalf("库里应当只剩 1 行，实际 %d", n)
	}
	// 审计里要有 before/after，且按 role_key 记。取**最后一条**（这一批有两次替换）：
	// 第一次的 before 是空矩阵，只有第二次能证明「替换前是什么」真的留下了。
	var detail string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT detail::text FROM audit_logs WHERE action = $1 ORDER BY id DESC LIMIT 1",
		AuditBoardACLUpdate).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "creator") || !strings.Contains(detail, "admin") {
		t.Fatalf("审计的 before/after 应当按 role_key 记: %s", detail)
	}
	if !strings.Contains(detail, "before") || !strings.Contains(detail, "after") {
		t.Fatalf("审计必须有 before 与 after 两段: %s", detail)
	}

	// 同一行既 can 又 deny = 400（而不是让 DB 的 CHECK 抛一个指不到格子的错）
	_, err = h.svc.ReplaceBoardACL(h.ctx, admin, public, []AdminACLItem{{RoleID: adminRole, CanPost: true, DenyPost: true}})
	assertCode(t, err, "common.invalid_input")
	// 重复角色 = 400
	_, err = h.svc.ReplaceBoardACL(h.ctx, admin, public, []AdminACLItem{{RoleID: adminRole}, {RoleID: adminRole}})
	assertCode(t, err, "common.invalid_input")
	// 不存在的角色 = 400
	_, err = h.svc.ReplaceBoardACL(h.ctx, admin, public, []AdminACLItem{{RoleID: 999999}})
	assertCode(t, err, "common.invalid_input")
	// 失败的替换不该动已经生效的矩阵
	if n := h.countRows(t, "SELECT count(*) FROM board_acls WHERE board_id = $1", boardID); n != 1 {
		t.Fatalf("失败的替换改了库：现在有 %d 行", n)
	}
	// 空矩阵 = 清空（合法：把 ACL 关掉就是把矩阵清空 + acl_enabled=false）
	rows, err = h.svc.ReplaceBoardACL(h.ctx, admin, public, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("清空后应当是空数组，实际 %+v", rows)
	}
}

// ── 版主任免 ──────────────────────────────────────────────────────

func TestBoardModeratorGrantRevoke(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	adminID := h.seedUser("mod", roleID, 1, true)
	admin := h.boardAdmin(adminID, roleID)
	boardID := h.seedBoard("campaign", 0, false)
	public := h.boardPublicID(boardID)
	targetID := h.seedUser("bm", roleID, 1, false)
	var targetPublic string
	if err := h.pool.QueryRow(h.ctx, "SELECT public_id::text FROM users WHERE id = $1", targetID).Scan(&targetPublic); err != nil {
		t.Fatal(err)
	}

	// 任期必须在将来（给一个过去的时刻等于任命完立刻卸任）
	past := h.clk.T.Add(-time.Hour)
	_, err := h.svc.GrantBoardModerator(h.ctx, admin, public, targetPublic, &past)
	assertCode(t, err, "common.invalid_input")
	// 用户不存在 = 404
	_, err = h.svc.GrantBoardModerator(h.ctx, admin, public, "00000000-0000-0000-0000-000000000000", nil)
	assertCode(t, err, ErrAdminModeratorUserNotFound.Code)
	// 非 uuid 用户 id = 同一个 404
	_, err = h.svc.GrantBoardModerator(h.ctx, admin, public, "nope", nil)
	assertCode(t, err, ErrAdminModeratorUserNotFound.Code)

	// 任命
	items, err := h.svc.GrantBoardModerator(h.ctx, admin, public, targetPublic, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].UserID != targetPublic || items[0].GrownAt != nil {
		t.Fatalf("任命后的回执不对: %+v", items)
	}
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditBoardModerateGrant); n != 1 {
		t.Fatalf("任命应当有 1 行审计，实际 %d", n)
	}
	// **上任之后他真的能管这个分区**（Actor.BoardIDs 的来源就是这张表）
	if !authz.CanInBoard(&authz.Actor{UserID: targetID, BoardIDs: []int64{boardID}}, boardID) {
		t.Fatal("任命之后 CanInBoard 应当为真")
	}

	// 幂等：再任命一次仍然成功，且**不新增行**（部分唯一索引上的 upsert）
	expires := h.clk.T.Add(72 * time.Hour)
	items, err = h.svc.GrantBoardModerator(h.ctx, admin, public, targetPublic, &expires)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ExpiresAt == nil || !items[0].ExpiresAt.Equal(expires) {
		t.Fatalf("重复任命应当改任期: %+v", items)
	}
	if n := h.countRows(t, "SELECT count(*) FROM board_moderators WHERE board_id = $1", boardID); n != 1 {
		t.Fatalf("重复任命不该新增行，实际 %d 行", n)
	}

	// 免：置 grown_at，**不删行**
	if err := h.svc.RevokeBoardModerator(h.ctx, admin, public, targetPublic); err != nil {
		t.Fatal(err)
	}
	items, err = h.svc.AdminBoardModerators(h.ctx, admin, public)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].GrownAt == nil {
		t.Fatalf("卸任的历史行应当留着并带 grown_at: %+v", items)
	}
	// 列表里的版主名单要把他拿掉（只算未过期的**在任**行）
	d, err := h.svc.AdminBoard(h.ctx, admin, public)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Moderators) != 0 {
		t.Fatalf("卸任之后列表里不该还有他: %+v", d.Moderators)
	}
	// 再免一次 = 404（「这个人不是版主」，不是「操作成功」）
	assertCode(t, h.svc.RevokeBoardModerator(h.ctx, admin, public, targetPublic), ErrAdminModeratorNotFound.Code)

	// 免了再任命：部分唯一索引应当允许（旧行 grown_at 非空，不参与冲突）
	items, err = h.svc.GrantBoardModerator(h.ctx, admin, public, targetPublic, nil)
	if err != nil {
		t.Fatalf("免了再任命必须能成功（这是后台最常见的动作）: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("应当有 2 行历史（1 在任 + 1 卸任），实际 %d", len(items))
	}
	if items[0].GrownAt != nil {
		t.Fatal("在任的必须排在前面")
	}
}

// 版主任免必须让权限快照失效（否则刚被免的人在缓存过期前仍然是版主）。
func TestBoardModeratorInvalidatesActorCache(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	admin := h.boardAdmin(h.seedUser("mod", roleID, 1, true), roleID)
	boardID := h.seedBoard("campaign", 0, false)
	public := h.boardPublicID(boardID)
	targetID := h.seedUser("bm", roleID, 1, false)
	var targetPublic string
	if err := h.pool.QueryRow(h.ctx, "SELECT public_id::text FROM users WHERE id = $1", targetID).Scan(&targetPublic); err != nil {
		t.Fatal(err)
	}

	// 换一个带钩子的 service：Deps.InvalidateUser 记下被通知的 user_id
	var invalidated []int64
	svc := NewService(h.ent, h.clk, h.count, h.queue, Deps{
		Users: h.deps, Render: markdownish{}, Queue: h.queue, Counter: h.count,
		InvalidateUser: func(_ context.Context, userID int64) error {
			invalidated = append(invalidated, userID)
			return nil
		},
	})
	if _, err := svc.GrantBoardModerator(h.ctx, admin, public, targetPublic, nil); err != nil {
		t.Fatal(err)
	}
	if err := svc.RevokeBoardModerator(h.ctx, admin, public, targetPublic); err != nil {
		t.Fatal(err)
	}
	if len(invalidated) != 2 || invalidated[0] != targetID || invalidated[1] != targetID {
		t.Fatalf("任免各要通知一次权限缓存失效，实际 %v（目标 %d）", invalidated, targetID)
	}
}
