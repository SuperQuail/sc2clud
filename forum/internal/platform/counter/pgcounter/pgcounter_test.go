package pgcounter

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/platform/clock"
	"forum/internal/platform/counter"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// 两张被计数表的最小子集：写回只碰 view_count / download_count 两列。
const tables = `
CREATE TABLE topics (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  view_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE release_assets (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  download_count bigint NOT NULL DEFAULT 0
);
`

func TestFlushBatchesByTableAndDoesNotDoubleCount(t *testing.T) {
	ctx, pool := testsupport.Pool(t)
	if _, err := pool.Exec(ctx, tables); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{
		"INSERT INTO topics (view_count) VALUES (0), (0), (0)",
		"INSERT INTO release_assets (download_count) VALUES (0), (0)",
	} {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}

	f := New(pool, clock.Real{})
	keys := []string{
		counter.TopicViewKey(1),
		counter.TopicViewKey(1),
		counter.TopicViewKey(3),
		counter.AssetDownloadKey(2),
	}
	deltas := []int64{2, 3, 1, 5}
	if err := f.Flush(ctx, keys, deltas); err != nil {
		t.Fatalf("flush: %v", err)
	}

	if got := scalar(t, ctx, pool, "SELECT view_count FROM topics WHERE id = 1"); got != 5 {
		t.Fatalf("同一个 topic 的两笔应当累加，实际 %d", got)
	}
	if got := scalar(t, ctx, pool, "SELECT view_count FROM topics WHERE id = 3"); got != 1 {
		t.Fatalf("topic 3 的浏览量不对: %d", got)
	}
	if got := scalar(t, ctx, pool, "SELECT view_count FROM topics WHERE id = 2"); got != 0 {
		t.Fatalf("没被计数的行必须保持 0，实际 %d", got)
	}
	if got := scalar(t, ctx, pool, "SELECT download_count FROM release_assets WHERE id = 2"); got != 5 {
		t.Fatalf("下载量不对: %d", got)
	}

	// 零增量不该改变任何值
	if err := f.Flush(ctx, []string{counter.TopicViewKey(1)}, []int64{0}); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, ctx, pool, "SELECT view_count FROM topics WHERE id = 1"); got != 5 {
		t.Fatalf("零增量不该改变值，实际 %d", got)
	}
}

func TestFlushRejectsUnknownKey(t *testing.T) {
	ctx, pool := testsupport.Pool(t)
	f := New(pool, clock.Real{})
	if err := f.Flush(ctx, []string{"garbage:1"}, []int64{1}); err == nil {
		t.Fatal("未知计数键必须报错，而不是静默丢数")
	}
}

func scalar(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sqlText string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(ctx, sqlText).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
