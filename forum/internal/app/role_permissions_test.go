package app

import (
	"context"
	"strings"
	"testing"

	"forum/internal/platform/db"
	"forum/migrations"
)

// D28：**默认权限矩阵的对照表**，逐点钉在真迁移上。
//
// 为什么必须跑真迁移而不是照抄一份常量：2026-10-15 实测发现 0017_seed_authz 给 admin 只写了
// 16 个点，而真源（完全重构/后端开工前拍板.md §1.3）要求 17 个 —— 漏的那个是 resource.publish，
// 于是管理员发 kind=resource 的帖子会被 403 拦下。这种偏差**只有把库里的矩阵读回来比对**
// 才看得见；auth 包的用例夹具自己另写了一份矩阵（fixture_test.go 的 seedRBAC），
// 库里的默认值再怎么错它都是绿的。
//
// 表里两个例外都写明了理由，不是「看着不对」：
//   - creator 多 topic.lock / topic.move：d2-auth §8.6 的明确取舍（创作者管**自己的**帖子）；
//   - admin 不含 role.edit/role.assign/permission.grant/site.setting/audit.*/mail.manage：
//     拍板 §1.3 把它们留给 superadmin（提权类权限只归最高角色）。
func TestMigratedRolePermissionMatrixMatchesSpec(t *testing.T) {
	if testing.Short() {
		t.Skip("要起真库跑全部迁移，-short 跳过")
	}
	const (
		topicCreate  = "topic.create"
		topicEditOwn = "topic.edit.own"
		topicDelOwn  = "topic.delete.own"
		topicDelAny  = "topic.delete.any"
		topicLock    = "topic.lock"
		topicPin     = "topic.pin"
		topicMove    = "topic.move"
		resPublish   = "resource.publish"
		boardManage  = "board.manage"
		boardMod     = "board.moderate"
		postReview   = "post.review"
		reportHandle = "report.handle"
		rewardVerify = "reward.verify"
		titleGrant   = "title.grant"
		titleManage  = "title.manage"
		userBan      = "user.ban"
		userMute     = "user.mute"
	)
	superKeys := []string{
		topicCreate, topicEditOwn, topicDelOwn, topicDelAny, topicLock, topicPin, topicMove, resPublish,
		boardManage, boardMod, postReview, reportHandle, userBan, userMute,
		"role.edit", "role.assign", "permission.grant", titleGrant, titleManage,
		rewardVerify, "mail.manage", "site.setting", "audit.view", "audit.export",
	}
	want := map[string][]string{
		"user":    {topicCreate, topicEditOwn, topicDelOwn},
		"creator": {topicCreate, topicEditOwn, topicDelOwn, topicPin, topicMove, topicLock, resPublish},
		"admin": {
			topicCreate, topicEditOwn, topicDelOwn, topicPin, resPublish, topicMove, topicLock, topicDelAny,
			userMute, boardMod, boardManage, postReview, reportHandle, rewardVerify, titleGrant, titleManage, userBan,
		},
		"superadmin": superKeys,
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

	rows, err := in.Pool.Query(ctx, `
		SELECT r.key, p.key
		  FROM role_permissions rp
		  JOIN roles r ON r.id = rp.role_id
		  JOIN permissions p ON p.id = rp.permission_id
		 WHERE r.key = ANY($1::text[])`, []string{"user", "creator", "admin", "superadmin"})
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]map[string]bool{}
	for rows.Next() {
		var role, perm string
		if err := rows.Scan(&role, &perm); err != nil {
			t.Fatal(err)
		}
		if got[role] == nil {
			got[role] = map[string]bool{}
		}
		got[role][perm] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	for role, wantPerms := range want {
		has := got[role]
		if has == nil {
			t.Fatalf("库里没有角色 %q —— 0017 没跑到？", role)
		}
		// 多出来的点同样要报：多一个点就是多一份权限，而「看着不对」不能当理由
		//（creator 的两个例外写在 want 里，所以这里严格相等）。
		var missing, extra []string
		for _, p := range wantPerms {
			if !has[p] {
				missing = append(missing, p)
			}
		}
		inWant := map[string]bool{}
		for _, p := range wantPerms {
			inWant[p] = true
		}
		for p := range has {
			if !inWant[p] {
				extra = append(extra, p)
			}
		}
		if len(missing) > 0 || len(extra) > 0 {
			t.Errorf("角色 %s 的默认矩阵与拍板 §1.3 不一致：\n  库里多出: %s\n  库里缺少: %s\n（真源：完全重构/后端开工前拍板.md §1.2/§1.3；改动要同时改迁移与这张表）",
				role, strings.Join(extra, ", "), strings.Join(missing, ", "))
		}
	}
}
