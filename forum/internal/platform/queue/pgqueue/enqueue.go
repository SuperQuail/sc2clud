package pgqueue

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/platform/queue"
)

// insertJobSQL 入队语句。unique_key 冲突必须静默跳过——EnqueueTx 在业务事务里，
// 让去重失败把用户发帖一起回滚是不可接受的（盲审 M5 的裁定）。
//
// conflict_target 必须带 WHERE 谓词，否则 PG 推断不到那个**部分**唯一索引
// （谓词形状要与索引定义逐字一致）。空 unique_key 被谓词排除，所以不参与去重。
const insertJobSQL = `
INSERT INTO jobs (type, payload, unique_key, priority, run_at, max_retry)
VALUES ($1, $2::jsonb, $3, $4, $5, $6)
ON CONFLICT (unique_key) WHERE unique_key <> '' AND status IN ('pending','running') DO NOTHING
`

// Enqueue 用在确实没有业务事务的路径上（cron、CLI）。它自己拿池里的一条连接。
func (q *Queue) Enqueue(ctx context.Context, t queue.Task) error {
	if err := q.enqueue(ctx, poolExecer{q.pool}, t); err != nil {
		return err
	}
	q.signal()
	return nil
}

// EnqueueTx 与业务数据同事务提交：事务回滚，任务也不存在。
// ent.Tx 有 ExecContext（ent 生成时开 sql/execquery 特性），所以直接传进来即可。
func (q *Queue) EnqueueTx(ctx context.Context, tx queue.TxExecutor, t queue.Task) error {
	return q.enqueue(ctx, tx, t)
}

func (q *Queue) enqueue(ctx context.Context, ex queue.TxExecutor, t queue.Task) error {
	payload, err := queue.MarshalPayload(t.Payload)
	if err != nil {
		return err
	}
	runAt := t.RunAt
	if runAt.IsZero() {
		runAt = q.clock.Now()
	}
	maxRetry := t.MaxRetry
	if maxRetry <= 0 {
		maxRetry = q.cfg.MaxRetry
	}
	if _, err := ex.ExecContext(ctx, insertJobSQL,
		t.Type, string(payload), t.UniqueKey, t.Priority, runAt.UTC(), maxRetry); err != nil {
		return fmt.Errorf("queue: enqueue %s: %w", t.Type, err)
	}
	return nil
}

// poolExecer 把 pgxpool 的 Exec 适配成 database/sql 的 ExecContext 形状。
// 只为 Enqueue（非事务路径）存在；EnqueueTx 直接用 ent.Tx 自己。
type poolExecer struct{ pool *pgxpool.Pool }

func (p poolExecer) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	tag, err := p.pool.Exec(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return tagAdapter{tag}, nil
}

type tagAdapter struct{ tag pgconn.CommandTag }

func (t tagAdapter) LastInsertId() (int64, error) {
	return 0, fmt.Errorf("pgx: LastInsertId unsupported")
}
func (t tagAdapter) RowsAffected() (int64, error) { return t.tag.RowsAffected(), nil }
