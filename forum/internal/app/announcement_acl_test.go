package app

import (
	"context"
	"testing"
	"time"

	"forum/internal/auth"
	authpgsql "forum/internal/auth/pgsql"
	"forum/internal/authz"
	"forum/internal/forum"
	"forum/internal/platform/apperr"
	"forum/internal/platform/db"
	"forum/migrations"
)

// announcement_acl_test.go：公告区「只有管理员能发」这条老站规则（第三轮拍板 §1c）。
//
// 老站真源：sections.post_min_role='admin'（公告区发帖）/ 'member'（公告区回复），
// core/resource.rs 的 PostSection::Announcement.required_permission() == ManageUsers。
// 新站的落点只能是 board_acls（等级门槛表达不了角色）—— 三条路与取舍写在《数据迁移审计》§6.5。
//
// 三件事一起钉，缺一条都证明不了「这条规则真的在库里」：
//  1. 库里是 ACL 白名单态：acl_enabled=true + 四个内置角色各一行；
//  2. 普通用户发公告区 → 拒绝（ACL 判定第 6 步白名单制；老站是角色门槛没到，两边都拒）；
//  3. 管理员 → 成功，且普通用户仍能回复（reply_min_role=member，回复这一档不能一起收紧）。
func TestAnnouncementBoardOnlyAdminsCanPost(t *testing.T) {
	if testing.Short() {
		t.Skip("要跑真迁移 + 真服务，-short 跳过")
	}
	ctx := context.Background()
	cfg := e2eConfig(t)
	if err := db.Migrate(ctx, cfg.DB.DSN, migrations.FS()); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}
	in, err := NewInfra(ctx, cfg, discardLogger())
	if err != nil {
		t.Fatalf("NewInfra: %v", err)
	}
	defer in.Close()
	if err := Seed(ctx, cfg); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	m, err := newModules(ctx, cfg, in)
	if err != nil {
		t.Fatalf("newModules: %v", err)
	}

	// ── 1. 库里是 ACL 白名单态 ────────────────────────────────────────
	var aclEnabled bool
	if err := in.Pool.QueryRow(ctx,
		"SELECT acl_enabled FROM boards WHERE slug = 'announcement'").Scan(&aclEnabled); err != nil {
		t.Fatalf("读公告区的 acl_enabled: %v", err)
	}
	if !aclEnabled {
		t.Fatal("公告区 acl_enabled 不是 true：角色门槛只能靠 board_acls 表达（min_post_level 是等级，不是角色）")
	}
	var rows int
	if err := in.Pool.QueryRow(ctx,
		"SELECT count(*) FROM board_acls a JOIN boards b ON b.id = a.board_id WHERE b.slug = 'announcement'").Scan(&rows); err != nil {
		t.Fatalf("数公告区的 ACL 行: %v", err)
	}
	if rows != 4 {
		t.Fatalf("公告区应当给四个内置角色各一行（user/creator/admin/superadmin），实际 %d 行", rows)
	}

	// ── 2. 普通用户发公告区 → 拒绝 ───────────────────────────────────
	member := seededActor(t, ctx, in, "demo-thor")
	if !member.Perms.Has(authz.PermTopicCreate) {
		t.Fatal("前置不成立：种子普通用户没有 topic.create —— 那样拒绝就无法归因到公告区这条规则")
	}
	_, err = m.Forum.CreateTopic(ctx, member, forum.CreateTopicInput{
		BoardSlug: "announcement", Title: "普通用户发的公告（应当被拒）", ContentMD: "正文",
	})
	if err == nil {
		t.Fatal("普通用户往公告区发帖成功了 —— 「只有管理员能发」在真站上是假的")
	}
	if code := appErrCode(t, err); code != "board.acl_denied" {
		t.Fatalf("期望 board.acl_denied（分区规则，不是等级门槛），实际 %s: %v", code, err)
	}

	// ── 3. 管理员 → 成功；普通用户仍能回复 ──────────────────────────
	admin := seededActor(t, ctx, in, "demo-admin")
	detail, err := m.Forum.CreateTopic(ctx, admin, forum.CreateTopicInput{
		BoardSlug: "announcement", Title: "管理员发的公告（应当成功）", ContentMD: "正文",
	})
	if err != nil {
		t.Fatalf("管理员往公告区发帖被拒了: %v", err)
	}
	if detail.Board.Slug != "announcement" {
		t.Fatalf("发到别的分区去了: %s", detail.Board.Slug)
	}
	if _, err := m.Forum.CreatePost(ctx, member, detail.ID, forum.CreatePostInput{ContentMD: "普通用户回一句"}); err != nil {
		t.Fatalf("老站公告区的 reply_min_role 是 member，普通用户应当能回复，实际: %v", err)
	}
}

// seededActor 把种子用户装成与请求路径同形的 Actor：权限闭包来自 auth/pgsql.LoadActor（唯一实现）。
func seededActor(t *testing.T, ctx context.Context, in *Infra, handle string) *authz.Actor {
	t.Helper()
	var userID, roleID int64
	if err := in.Pool.QueryRow(ctx,
		"SELECT id, role_id FROM users WHERE username = $1", handle).Scan(&userID, &roleID); err != nil {
		t.Fatalf("读种子用户 %s（先跑 seed）: %v", handle, err)
	}
	ar, err := authpgsql.LoadActor(ctx, in.DB, roleID, userID, time.Now().UTC())
	if err != nil {
		t.Fatalf("装配 %s 的权限: %v", handle, err)
	}
	p := &auth.Principal{
		UserID: userID, PublicID: ar.PublicID, Status: ar.Status,
		EmailVerified: ar.EmailVerified != nil, Activated: ar.ActivatedAt != nil,
		RoleID: ar.RoleID, RoleKey: ar.RoleKey, RoleName: ar.RoleName,
		IsSuper: ar.IsSuper, Perms: authz.NewSet(ar.PermKeys...), BoardIDs: ar.BoardIDs,
	}
	return p.Actor()
}

func appErrCode(t *testing.T, err error) string {
	t.Helper()
	ae, ok := err.(*apperr.Error)
	if !ok {
		t.Fatalf("期望业务错误（带 code），实际 %T: %v", err, err)
	}
	return ae.Code
}
