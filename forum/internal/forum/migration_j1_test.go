package forum

import (
	"os"
	"path/filepath"
	"testing"

	"forum/internal/testsupport"
)

// J1（拍板 08）：`moderator` → `creator` 是**自动迁移**。
//
// 0017_seed_authz 从来只种 user/creator/admin/superadmin，所以候选只在**自定义角色**那一路
// （后台可以建 key=moderator 的角色；W5 的 DevRoom 假数据就是这么造的）。
// 这条用例在一个真库上把 0023 向上跑一遍，钉住三件事：
//   - 用户的 role_id 改挂 creator（users.role_id 是 ON DELETE RESTRICT，不先改就删不掉）；
//   - moderator 的权限矩阵并进 creator，不丢勾选；
//   - moderator 这行没了（不许两个 key 表达同一件事）。
func TestMigrationModeratorBecomesCreator(t *testing.T) {
	ctx, pool := testsupport.Pool(t)
	migrateAll(t, ctx, pool)

	up, err := os.ReadFile(filepath.Join(testsupport.MigrationsDir(), "0023_moderator_to_creator.up.sql"))
	if err != nil {
		t.Fatalf("读不到 0023 的 up：%v", err)
	}
	down, err := os.ReadFile(filepath.Join(testsupport.MigrationsDir(), "0023_moderator_to_creator.down.sql"))
	if err != nil {
		t.Fatalf("读不到 0023 的 down：%v", err)
	}
	run := func(sql string) {
		t.Helper()
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("迁移执行失败: %v", err)
		}
	}
	// 把库先退回 0023 之前：删掉这条迁移的产物 + 造一个自定义 moderator。
	// （migrateAll 已经把 0023 跑过：creator 在内置四角色里本来就有。）
	run("DELETE FROM roles WHERE key = 'moderator'")
	run(`INSERT INTO roles (key, name, description, depth, is_system, priority)
	      VALUES ('moderator', '分区版主', '自定义角色（旧名）', 2, false, 30)`)
	run(`INSERT INTO role_permissions (role_id, permission_id)
	      SELECT r.id, p.id FROM roles r, permissions p
	       WHERE r.key = 'moderator' AND p.key = 'report.handle'`)
	var modID, userID int64
	if err := pool.QueryRow(ctx, "SELECT id FROM roles WHERE key = 'moderator'").Scan(&modID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
	      VALUES (gen_random_uuid(), 'mod-user', 'mod@example.com', 'x', 'mod', $1) RETURNING id`, modID).Scan(&userID); err != nil {
		t.Fatal(err)
	}

	run(string(up))

	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM roles WHERE key = 'moderator'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("moderator 应当被并进 creator，实际还剩 %d 行", n)
	}
	// 用户改挂 creator
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id
 WHERE u.id = $1 AND r.key = 'creator'`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("用户应当改挂 creator，实际命中 %d 行", n)
	}
	// 矩阵并进 creator：creator 现在必须有 report.handle
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  JOIN permissions p ON p.id = rp.permission_id
 WHERE r.key = 'creator' AND p.key = 'report.handle'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("moderator 的矩阵应当并进 creator，report.handle 命中 %d 行", n)
	}

	// down 让 `moderator` 这个名字重新可用（空的自定义角色），不再有用户挂在它下面。
	run(string(down))
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM roles WHERE key = 'moderator'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("down 之后 moderator 应当重新存在，实际 %d 行", n)
	}
}
