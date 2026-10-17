package pgqueue

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/config"
	entgen "forum/internal/ent"
	"forum/internal/platform/clock"
	"forum/internal/platform/db"
	"forum/internal/platform/queue"
	"forum/internal/testsupport"
)

// jobsTestDDL 与 migrations/postgres/0015_queue.up.sql 一致；
// 另有一条测试直接读迁移文件，防止两份 DDL 漂移。
const jobsTestDDL = `
CREATE TABLE jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type         text        NOT NULL,
  payload      jsonb       NOT NULL,
  unique_key   text        NOT NULL DEFAULT '',
  status       text        NOT NULL DEFAULT 'pending'
               CONSTRAINT ck_jobs_status CHECK (status IN ('pending','running','done','dead')),
  priority     int         NOT NULL DEFAULT 0,
  attempts     int         NOT NULL DEFAULT 0,
  max_retry    int         NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  locked_by    text        NOT NULL DEFAULT '',
  last_error   text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_jobs_lease CHECK (status = 'running' OR locked_until IS NULL)
);
CREATE UNIQUE INDEX uq_jobs_unique_key ON jobs (unique_key)
  WHERE unique_key <> '' AND status IN ('pending','running');
CREATE INDEX idx_jobs_claim ON jobs (priority DESC, run_at, id) WHERE status = 'pending';
CREATE INDEX idx_jobs_recover ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX idx_jobs_cleanup ON jobs (status, updated_at);
`

func TestMain(m *testing.M) { testsupport.Main(m) }

func quiet() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

func testCfg() config.Queue {
	return config.Queue{
		PollInterval: 10 * time.Millisecond,
		Lease:        5 * time.Minute,
		MaxRetry:     3,
		BackoffBase:  10 * time.Second,
		BackoffCap:   time.Hour,
		DoneKeep:     7 * 24 * time.Hour,
		DeadKeep:     30 * 24 * time.Hour,
	}
}

// newQueue 每个用例一个独立 schema + 一张干净的 jobs 表。
func newQueue(t *testing.T) (*Queue, *pgxpool.Pool, context.Context) {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	if _, err := pool.Exec(ctx, jobsTestDDL); err != nil {
		t.Fatalf("建 jobs 表失败: %v", err)
	}
	return New(pool, clock.Real{}, quiet(), testCfg()), pool, ctx
}

func count(t *testing.T, pool *pgxpool.Pool, where string, args ...any) int {
	t.Helper()
	var n int
	q := "SELECT count(*) FROM jobs"
	if where != "" {
		q += " WHERE " + where
	}
	if err := pool.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestClaimNeverHandsOutTheSameJobTwice(t *testing.T) {
	q, pool, ctx := newQueue(t)
	const total = 8
	q.Handle("test:noop", func(context.Context, []byte) error { return nil })
	for i := 0; i < total; i++ {
		if err := q.Enqueue(ctx, queue.Task{Type: "test:noop", Payload: map[string]int{"i": i}}); err != nil {
			t.Fatalf("enqueue: %v", err)
		}
	}

	const workers = 4
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			for {
				n, err := q.step(ctx, "test-instance", slot)
				if err != nil {
					t.Errorf("step: %v", err)
					return
				}
				if n == 0 {
					return
				}
			}
		}(w)
	}
	wg.Wait()

	// 每条任务恰好被领一次 = 全部跑完（done）且 attempts 都是 1；有任何一条 attempts>1 就是被领重了
	if n := count(t, pool, "status = 'done'"); n != total {
		t.Fatalf("应当有 %d 条跑完，实际 done=%d", total, n)
	}
	if n := count(t, pool, "attempts <> 1"); n != 0 {
		t.Fatalf("有 %d 条被领了不止一次（并发领取重复了）", n)
	}
	if n := count(t, pool, "status IN ('pending','running')"); n != 0 {
		t.Fatalf("还有 %d 条没被领走", n)
	}
}

func TestUniqueKeyIsIdempotentAndReleasedWhenFinished(t *testing.T) {
	q, pool, ctx := newQueue(t)
	task := queue.Task{Type: "mail:send", Payload: map[string]int{"id": 1}, UniqueKey: "mail:1"}

	if err := q.Enqueue(ctx, task); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := q.Enqueue(ctx, task); err != nil {
		t.Fatalf("第二次同 key 入队必须静默跳过（不能报错，否则会把业务事务一起回滚）: %v", err)
	}
	if n := count(t, pool, ""); n != 1 {
		t.Fatalf("同 unique_key 应当只有一条，实际 %d", n)
	}

	// 完成之后同一个 key 必须能再次入队——这正是「部分」唯一索引存在的理由
	if _, err := pool.Exec(ctx, "UPDATE jobs SET status='done', updated_at=now()"); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(ctx, task); err != nil {
		t.Fatalf("done 之后同 key 入队: %v", err)
	}
	if n := count(t, pool, ""); n != 2 {
		t.Fatalf("done 之后应当能再入队，实际 %d 行", n)
	}
}

func TestEmptyUniqueKeyNeverDeduplicates(t *testing.T) {
	q, pool, ctx := newQueue(t)
	for i := 0; i < 3; i++ {
		if err := q.Enqueue(ctx, queue.Task{Type: "test:noop"}); err != nil {
			t.Fatalf("enqueue: %v", err)
		}
	}
	if n := count(t, pool, ""); n != 3 {
		t.Fatalf("空 unique_key 不参与去重，应当有 3 行，实际 %d", n)
	}
}

type boomErr struct{}

func (boomErr) Error() string { return "boom" }

func TestRetryBackoffAndDead(t *testing.T) {
	q, pool, ctx := newQueue(t)
	q.Handle("flaky", func(context.Context, []byte) error { return boomErr{} })
	if err := q.Enqueue(ctx, queue.Task{Type: "flaky", MaxRetry: 2}); err != nil {
		t.Fatal(err)
	}

	if _, err := q.step(ctx, "inst", 0); err != nil {
		t.Fatal(err)
	}
	var (
		status   string
		attempts int
		runAt    time.Time
		lastErr  string
	)
	if err := pool.QueryRow(ctx, "SELECT status, attempts, run_at, last_error FROM jobs").Scan(&status, &attempts, &runAt, &lastErr); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || attempts != 1 {
		t.Fatalf("第一次失败后应当是 pending/attempts=1，实际 %s/%d", status, attempts)
	}
	if time.Until(runAt) < 5*time.Second {
		t.Fatalf("退避没生效：run_at=%v（期望约 10s 之后）", runAt)
	}
	if lastErr == "" {
		t.Fatal("last_error 必须记下失败原因")
	}

	// max_retry=2 的含义是「最多尝试 2 次」：第 2 次失败后直接 dead，不再排期
	if _, err := pool.Exec(ctx, "UPDATE jobs SET run_at = now() - interval '1s'"); err != nil {
		t.Fatal(err)
	}
	if _, err := q.step(ctx, "inst", 0); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT status, attempts FROM jobs").Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "dead" {
		t.Fatalf("第 max_retry 次失败后必须 dead，实际 %s", status)
	}
	if attempts != 2 {
		t.Fatalf("attempts 应当等于 max_retry(2)，实际 %d", attempts)
	}
	// dead 的任务不该再被领走
	if n, err := q.step(ctx, "inst", 0); err != nil || n != 0 {
		t.Fatalf("dead 的任务不该再被领取: n=%d err=%v", n, err)
	}
	var locked *time.Time
	if err := pool.QueryRow(ctx, "SELECT locked_until FROM jobs").Scan(&locked); err != nil {
		t.Fatal(err)
	}
	if locked != nil {
		t.Fatal("dead 之后必须释放租约")
	}
}

func TestSkipRetryGoesDeadImmediately(t *testing.T) {
	q, pool, ctx := newQueue(t)
	q.Handle("skip", func(context.Context, []byte) error { return queue.ErrSkipRetry })
	if err := q.Enqueue(ctx, queue.Task{Type: "skip", MaxRetry: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.step(ctx, "inst", 0); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, "status = 'dead'"); n != 1 {
		t.Fatalf("ErrSkipRetry 必须直接 dead（不消耗重试次数），实际 dead=%d", n)
	}
}

func TestUnknownTypeGoesDead(t *testing.T) {
	q, pool, ctx := newQueue(t)
	if err := q.Enqueue(ctx, queue.Task{Type: "nobody:registered"}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.step(ctx, "inst", 0); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, "status = 'dead' AND last_error LIKE 'unknown task type%'"); n != 1 {
		t.Fatalf("未注册类型必须直接 dead 并写明原因，实际 %d", n)
	}
}

func TestHandlerPanicIsFailureNotCrash(t *testing.T) {
	q, pool, ctx := newQueue(t)
	q.Handle("panic", func(context.Context, []byte) error { panic("boom") })
	if err := q.Enqueue(ctx, queue.Task{Type: "panic", MaxRetry: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.step(ctx, "inst", 0); err != nil {
		t.Fatalf("panic 不该让 step 返回错误: %v", err)
	}
	var status, lastErr string
	if err := pool.QueryRow(ctx, "SELECT status, last_error FROM jobs").Scan(&status, &lastErr); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("panic 必须按可重试失败处理（maxRetry=2 时回 pending），实际 %s", status)
	}
	if !strings.Contains(lastErr, "panic") {
		t.Fatalf("last_error 里应当有 panic 痕迹，实际 %q", lastErr)
	}
}

func TestRecoverLeases(t *testing.T) {
	q, pool, ctx := newQueue(t)
	if _, err := pool.Exec(ctx, `
INSERT INTO jobs (type, payload, status, locked_until, locked_by, attempts)
VALUES ('test:noop', '{}'::jsonb, 'running', now() - interval '1 minute', 'dead-instance', 1)`); err != nil {
		t.Fatal(err)
	}
	q.recoverLeases(ctx)
	var (
		status string
		locked *time.Time
	)
	if err := pool.QueryRow(ctx, "SELECT status, locked_until FROM jobs").Scan(&status, &locked); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || locked != nil {
		t.Fatalf("超租约的 running 必须被收回，实际 %s/%v", status, locked)
	}
}

func TestCleanupRespectsRetention(t *testing.T) {
	q, pool, ctx := newQueue(t)
	stmts := []string{
		`INSERT INTO jobs (type, payload, status, updated_at) VALUES ('t','{}'::jsonb,'done', now() - interval '8 days')`,
		`INSERT INTO jobs (type, payload, status, updated_at) VALUES ('t','{}'::jsonb,'done', now() - interval '1 day')`,
		`INSERT INTO jobs (type, payload, status, updated_at) VALUES ('t','{}'::jsonb,'dead', now() - interval '31 days')`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	q.cleanup(ctx)
	if n := count(t, pool, ""); n != 1 {
		t.Fatalf("只应删掉超期的 done/dead，实际剩 %d 行", n)
	}
	if n := count(t, pool, "status='done'"); n != 1 {
		t.Fatalf("保留期内（1 天）的 done 不该被删，实际 done=%d", n)
	}
}

func TestQueueConstraintsHold(t *testing.T) {
	_, pool, ctx := newQueue(t)
	if _, err := pool.Exec(ctx, `INSERT INTO jobs (type, payload, status, locked_until) VALUES ('t','{}'::jsonb,'pending', now())`); err == nil {
		t.Fatal("pending 带租约必须被 CHECK 挡住")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO jobs (type, payload, status) VALUES ('t','{}'::jsonb,'nonsense')`); err == nil {
		t.Fatal("非法 status 必须被 CHECK 挡住")
	}
}

func TestNoopHandlerRunsToDone(t *testing.T) {
	// 注册过的类型必须跑到 done，而不是像未注册类型那样直接 dead
	q, pool, ctx := newQueue(t)
	q.Handle("test:noop", func(context.Context, []byte) error { return nil })
	if err := q.Enqueue(ctx, queue.Task{Type: "test:noop"}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.step(ctx, "inst", 0); err != nil {
		t.Fatal(err)
	}
	if n := count(t, pool, "status = 'done' AND locked_until IS NULL"); n != 1 {
		t.Fatalf("成功任务必须 done 且释放租约，实际 %d", n)
	}
}

// 这三条验的是 d1 §6.3 的核心性质：EnqueueTx 与业务数据**同事务**。
// 它同时是「*ent.Tx 的 ExecContext 跑在同一个 *sql.Tx 上」的可执行证明——
// 如果哪天它跑到别的连接上，回滚那条会立刻红。
func TestEnqueueTxSharesBusinessTransaction(t *testing.T) {
	q, pool, ctx := newQueue(t)
	client := entgen.NewClient(entgen.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })

	if _, err := pool.Exec(ctx, "CREATE TABLE biz (id bigint PRIMARY KEY, note text NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	biz := func() int {
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM biz").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// ① 提交：业务行与任务一起落库
	if err := db.WithTx(ctx, client, func(tx *entgen.Tx) error {
		if _, err := tx.ExecContext(ctx, "INSERT INTO biz (id, note) VALUES (1, 'a')"); err != nil {
			return err
		}
		return q.EnqueueTx(ctx, tx, queue.Task{Type: "test:noop", UniqueKey: "tx-1"})
	}); err != nil {
		t.Fatalf("WithTx: %v", err)
	}
	if n := biz(); n != 1 {
		t.Fatalf("提交后业务行应当是 1，实际 %d", n)
	}
	if n := count(t, pool, ""); n != 1 {
		t.Fatalf("提交后任务应当是 1，实际 %d", n)
	}

	// ② 回滚：业务行与任务一起消失（这条证明 EnqueueTx 用的是同一个事务）
	want := boomErr{}
	if err := db.WithTx(ctx, client, func(tx *entgen.Tx) error {
		if _, err := tx.ExecContext(ctx, "INSERT INTO biz (id, note) VALUES (2, 'b')"); err != nil {
			return err
		}
		if err := q.EnqueueTx(ctx, tx, queue.Task{Type: "test:noop", UniqueKey: "tx-2"}); err != nil {
			return err
		}
		return want
	}); !errors.Is(err, want) {
		t.Fatalf("WithTx 应当返回业务错误，实际 %v", err)
	}
	if n := biz(); n != 1 {
		t.Fatalf("回滚后业务行应当还是 1，实际 %d", n)
	}
	if n := count(t, pool, ""); n != 1 {
		t.Fatalf("回滚后任务数应当还是 1（新任务必须一起回滚），实际 %d", n)
	}

	// ③ unique_key 冲突不能把业务事务一起回滚（盲审 M5 的裁定）
	if err := db.WithTx(ctx, client, func(tx *entgen.Tx) error {
		if _, err := tx.ExecContext(ctx, "INSERT INTO biz (id, note) VALUES (3, 'c')"); err != nil {
			return err
		}
		// tx-1 已存在且是 pending：这一次必须静默跳过
		return q.EnqueueTx(ctx, tx, queue.Task{Type: "test:noop", UniqueKey: "tx-1"})
	}); err != nil {
		t.Fatalf("unique_key 冲突必须静默跳过，不能报错: %v", err)
	}
	if n := biz(); n != 2 {
		t.Fatalf("冲突时业务行必须照常提交，实际 %d", n)
	}
	if n := count(t, pool, ""); n != 1 {
		t.Fatalf("冲突时任务数不变，实际 %d", n)
	}
}

func TestMigrationFileMatchesTestDDL(t *testing.T) {
	// 守卫：迁移文件与测试 DDL 必须讲同一件事（两份 DDL 漂移过一次就够贵了）
	raw, err := os.ReadFile(filepath.Join(testsupport.MigrationsDir(), "0015_queue.up.sql"))
	if err != nil {
		t.Skipf("迁移文件还没写出来: %v", err)
	}
	for _, want := range []string{"uq_jobs_unique_key", "idx_jobs_claim", "ck_jobs_lease", "payload      jsonb"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("0015_queue.up.sql 里缺少 %q", want)
		}
	}
}
