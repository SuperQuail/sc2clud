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

// newSchema 只跑 0002（users）+ 0008（messages）：本包查询的全部依赖。
func newSchema(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	dir := testsupport.MigrationsDir()
	for _, name := range []string{"0002_accounts.up.sql", "0008_message.up.sql"} {
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

// seed 造：me 与 3 个人的各 50 条会话 + 另外两人之间的 5 万条。
// 行数必须够多——几百行时规划器**合理地**选 Seq Scan，那测不出索引是否可用（d4 的预期按生产量级给）。
func seed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, me, peerA, peerB, peerC int64) {
	t.Helper()
	for _, peer := range []int64{peerA, peerB, peerC} {
		if _, err := pool.Exec(ctx, `
INSERT INTO messages (public_id, low_id, high_id, sender_id, body)
SELECT gen_random_uuid(), LEAST($1::bigint, $2::bigint), GREATEST($1::bigint, $2::bigint), $2::bigint, 'x'
  FROM generate_series(1, 50) g`, me, peer); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO messages (public_id, low_id, high_id, sender_id, body)
SELECT gen_random_uuid(), LEAST($1::bigint, $2::bigint), GREATEST($1::bigint, $2::bigint), $1::bigint, 'x'
  FROM generate_series(1, 50000) g`, peerB, peerC); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "ANALYZE messages"); err != nil {
		t.Fatal(err)
	}
}

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
		b.WriteString(line + "\n")
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// d4 §8.2 的 EXPLAIN 闸门：会话列表两侧各走一条 pair 索引，不许全表扫。
func TestConversationListPlanUsesBothPairIndexes(t *testing.T) {
	ctx, pool := newSchema(t)
	me := newUser(t, ctx, pool, "me")
	a := newUser(t, ctx, pool, "a")
	b := newUser(t, ctx, pool, "b")
	c := newUser(t, ctx, pool, "c")
	seed(t, ctx, pool, me, a, b, c)

	got := plan(t, ctx, pool, listConversationsSQL, me, 0, 20)
	for _, want := range []string{"idx_messages_pair_low", "idx_messages_pair_high"} {
		if !strings.Contains(got, want) {
			t.Fatalf("会话列表没用上 %s:\n%s", want, got)
		}
	}
	if strings.Contains(got, "Seq Scan on messages") {
		t.Fatalf("会话列表出现了全表扫:\n%s", got)
	}
}

// 未读角标必须走两条未读部分索引。
func TestUnreadTotalPlanUsesPartialIndexes(t *testing.T) {
	ctx, pool := newSchema(t)
	me := newUser(t, ctx, pool, "me")
	a := newUser(t, ctx, pool, "a")
	b := newUser(t, ctx, pool, "b")
	c := newUser(t, ctx, pool, "c")
	seed(t, ctx, pool, me, a, b, c)

	got := plan(t, ctx, pool, unreadTotalSQL, me)
	if !strings.Contains(got, "idx_messages_unread_low") || !strings.Contains(got, "idx_messages_unread_high") {
		t.Fatalf("未读角标没用上两条部分索引:\n%s", got)
	}
	if strings.Contains(got, "Seq Scan on messages") {
		t.Fatalf("未读角标出现了全表扫:\n%s", got)
	}
}

// 会话内翻页走 pair 索引。
func TestThreadPlanUsesPairIndex(t *testing.T) {
	ctx, pool := newSchema(t)
	me := newUser(t, ctx, pool, "me")
	a := newUser(t, ctx, pool, "a")
	b := newUser(t, ctx, pool, "b")
	c := newUser(t, ctx, pool, "c")
	seed(t, ctx, pool, me, a, b, c)

	low, high := me, a
	if low > high {
		low, high = high, low
	}
	// 两条 pair 索引都能服务这条 SQL（WHERE 里两列都有），规划器选哪条都行——
	// 真正的闸门是「不许全表扫」：两条索引存在的理由在会话列表那一侧（只过滤一列）。
	got := plan(t, ctx, pool, threadLowSQL, low, high, 0, 20)
	if !strings.Contains(got, "idx_messages_pair_low") && !strings.Contains(got, "idx_messages_pair_high") {
		t.Fatalf("会话内翻页没用上 pair 索引:\n%s", got)
	}
	if strings.Contains(got, "Seq Scan on messages") {
		t.Fatalf("会话内翻页出现了全表扫:\n%s", got)
	}
}
