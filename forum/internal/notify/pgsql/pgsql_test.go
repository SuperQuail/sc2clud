package pgsql

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// newSchema 只跑 0002（users）+ 0007（notifications / notification_mutes）：
// 这两张表就是本包全部查询的依赖，跑全量迁移没必要（0004 目前还有双主键缺陷）。
func newSchema(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	dir := testsupport.MigrationsDir()
	for _, name := range []string{"0002_accounts.up.sql", "0007_notify.up.sql"} {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, execErr := conn.Conn().PgConn().Exec(ctx, string(raw)).ReadAll()
		conn.Release()
		if execErr != nil {
			t.Fatalf("跑迁移 %s 失败: %v", name, execErr)
		}
	}
	// 0017_seed_authz 没在这里跑，users.role_id 的外键自己补一行
	if _, err := pool.Exec(ctx, "INSERT INTO roles (key, name) VALUES ('user', '普通用户')"); err != nil {
		t.Fatal(err)
	}
	return ctx, pool
}

func newUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
INSERT INTO users (public_id, username, email, password_hash, nickname, role_id, status)
VALUES (gen_random_uuid(), $1::varchar, $1::text || '@t.local', 'x', $1::varchar,
        (SELECT id FROM roles WHERE key = 'user'), 'active')
RETURNING id`, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// seed 造 1000 条别人的通知 + 50 条我的（其中 20 条未读）并 ANALYZE：
// 行数太少时规划器会**合理地**选 Seq Scan，那就测不出索引是否被用上。
func seed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, me, other int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
INSERT INTO notifications (public_id, user_id, actor_id, type, link, dedup_key, read_at)
SELECT gen_random_uuid(), $1, $2, 'reply', '/t/x', 'reply:post:' || g, NULL
  FROM generate_series(1, 1000) g`, other, me); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO notifications (public_id, user_id, actor_id, type, link, dedup_key, read_at)
SELECT gen_random_uuid(), $1, $2, 'reply', '/t/x',
       'reply:topic:' || g, CASE WHEN g <= 20 THEN NULL ELSE now() END
  FROM generate_series(1, 50) g`, me, other); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "ANALYZE notifications"); err != nil {
		t.Fatal(err)
	}
}

// plan 返回 EXPLAIN 的文本（不 ANALYZE：闸门只看计划形状）。
func plan(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) string {
	t.Helper()
	rows, err := pool.Query(ctx, "EXPLAIN "+query, args...)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// d4 §8.1 的 EXPLAIN 闸门：通知列表必须走 idx_notifications_inbox，不许全表扫。
func TestListNotificationsPlanUsesInboxIndex(t *testing.T) {
	ctx, pool := newSchema(t)
	me := newUser(t, ctx, pool, "me")
	other := newUser(t, ctx, pool, "other")
	seed(t, ctx, pool, me, other)

	got := plan(t, ctx, pool, listSQL, me, nil, 0, "", false, 20)
	if !strings.Contains(got, "idx_notifications_inbox") {
		t.Fatalf("列表查询没用上 idx_notifications_inbox:\n%s", got)
	}
	if strings.Contains(got, "Seq Scan on notifications") {
		t.Fatalf("列表查询出现了全表扫:\n%s", got)
	}

	// 带 kind 过滤与只取未读时也不许退化成全表扫
	got = plan(t, ctx, pool, listSQL, me, nil, 0, "reply", true, 20)
	if strings.Contains(got, "Seq Scan on notifications") {
		t.Fatalf("带 kind/unread 过滤时出现全表扫:\n%s", got)
	}
}

// d4 §4.2：未读角标必须走部分索引（谓词只要与索引差一个字，这里就会红）。
func TestUnreadCountPlanUsesPartialIndex(t *testing.T) {
	ctx, pool := newSchema(t)
	me := newUser(t, ctx, pool, "me")
	other := newUser(t, ctx, pool, "other")
	seed(t, ctx, pool, me, other)

	got := plan(t, ctx, pool, unreadCountSQL, me)
	if !strings.Contains(got, "idx_notifications_unread") {
		t.Fatalf("未读计数没用上 idx_notifications_unread:\n%s", got)
	}
	if strings.Contains(got, "Seq Scan on notifications") {
		t.Fatalf("未读计数出现了全表扫:\n%s", got)
	}
}
