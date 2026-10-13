package pgqueue

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"forum/internal/platform/queue"
)

// 领取：一条语句 + FOR UPDATE SKIP LOCKED。
// 子查询的 WHERE 与 ORDER BY 必须与 idx_jobs_claim（priority DESC, run_at, id）WHERE status='pending' 同序，
// 否则每个 worker 都在排序整个表。LIMIT 1 让索引扫描取到第一行就停。
const claimSQL = `
UPDATE jobs SET
       status       = 'running',
       locked_until = $1,
       locked_by    = $2,
       attempts     = attempts + 1,
       updated_at   = $1
 WHERE id = (
       SELECT id FROM jobs
        WHERE status = 'pending' AND run_at <= $1
        ORDER BY priority DESC, run_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
 )
RETURNING id, type, payload, attempts, max_retry
`

const (
	// 成功：只用 $1..$3，参数列表与 SQL 严格对应（多一个没被引用的参数会让 PG 推断不出类型）
	doneSQL = `
UPDATE jobs SET status = 'done', locked_until = NULL, last_error = '', updated_at = $3
 WHERE id = $1 AND locked_by = $2 AND status = 'running'
`

	// 失败待重试。$4 必须显式 ::timestamptz：DescribeExec 模式下 PG 先推断参数类型，
	// 而 "unknown + interval" 会被推断成 interval + interval（$4 成了 interval），
	// 赋值给 timestamptz 列时就报「表达式的类型为 interval」（踩过）。
	retrySQL = `
UPDATE jobs SET
       status       = 'pending',
       run_at       = $4::timestamptz + (LEAST($5::double precision * power(2, attempts), $6::double precision) * interval '1 second'),
       locked_until = NULL,
       locked_by    = '',
       last_error   = $3,
       updated_at   = $4::timestamptz
 WHERE id = $1 AND locked_by = $2 AND status = 'running'
`

	deadSQL = `
UPDATE jobs SET status = 'dead', locked_until = NULL, locked_by = '', last_error = $3, updated_at = $4
 WHERE id = $1 AND locked_by = $2 AND status = 'running'
`

	recoverSQL = `
UPDATE jobs SET status = 'pending', locked_until = NULL, locked_by = '', updated_at = $1
 WHERE status = 'running' AND locked_until < $1
`

	cleanupDoneSQL  = "DELETE FROM jobs WHERE status = 'done' AND updated_at < $1"
	cleanupDeadSQL  = "DELETE FROM jobs WHERE status = 'dead' AND updated_at < $1"
	shutdownWaitCap = 15 * time.Second
)

// Run 启动 workers 个消费槽 + 两个后台维护循环。
// ctx 取消后：不再领新任务，等在途任务结束再返回（超时上限 15s）。
func (q *Queue) Run(ctx context.Context) error {
	instance := newInstanceID(q.clock)
	// 并发数由 app 层按容量档位算好（small 4 / standard 8）后写进 cfg，
	// 这里只是兜底：真取不到就用 4，绝不用 0（0 个 worker = 队列永远不动）。
	workers := q.cfg.WorkersFor("")
	if workers <= 0 {
		workers = 4
	}
	q.log.Info("queue: worker 启动", "workers", workers, "instance", instance)

	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			q.slot(ctx, stop, instance, slot)
		}(i)
	}

	recover := time.NewTicker(time.Minute)
	cleanup := time.NewTicker(time.Hour)
	defer recover.Stop()
	defer cleanup.Stop()
	maintenance := make(chan struct{})
	go func() {
		for {
			select {
			case <-ctx.Done():
				close(maintenance)
				return
			case <-recover.C:
				q.recoverLeases(ctx)
			case <-cleanup.C:
				q.cleanup(ctx)
			}
		}
	}()

	<-ctx.Done()
	close(stop)
	<-maintenance

	// 等在途任务结束；超时也要返回，否则进程退不出去（被中断的任务由崩溃恢复捞回）
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(shutdownWaitCap):
		q.log.Warn("queue: 关闭超时，仍有在途任务", "wait", shutdownWaitCap)
	}
	return nil
}

func (q *Queue) slot(ctx context.Context, stop <-chan struct{}, instance string, slot int) {
	tick := time.NewTicker(q.cfg.PollInterval)
	defer tick.Stop()
	for {
		for {
			n, err := q.step(ctx, instance, slot)
			if err != nil {
				if ctx.Err() == nil {
					q.log.Error("queue: 领取失败", "err", err.Error(), "slot", slot)
				}
				break
			}
			if n == 0 {
				break
			}
		}
		select {
		case <-stop:
			return
		case <-tick.C:
		case <-q.wake:
		}
	}
}

// step 领一条并处理；返回处理了几条（0 表示队列空）。
func (q *Queue) step(ctx context.Context, instance string, slot int) (int, error) {
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	now := q.clock.Now()
	lease := now.Add(q.cfg.Lease)
	row := q.pool.QueryRow(ctx, claimSQL, lease, instance)
	var (
		id       int64
		typ      string
		payload  []byte
		attempts int
		maxRetry int
	)
	if err := row.Scan(&id, &typ, &payload, &attempts, &maxRetry); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			q.log.Debug("queue: 空轮询", "slot", slot)
			return 0, nil
		}
		return 0, fmt.Errorf("claim: %w", err)
	}
	q.execute(ctx, id, typ, payload, attempts, maxRetry, instance)
	return 1, nil
}

func (q *Queue) execute(ctx context.Context, id int64, typ string, payload []byte, attempts, maxRetry int, instance string) {
	// 收尾/重试用独立的 context（不带父 ctx 的取消与超时）：
	// 进程正在关闭时 ctx 已经取消，而那正是最需要把任务状态写回数据库的时刻。
	finishCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	h, ok := q.handler(typ)
	if !ok {
		// 类型常量是代码写死的：出现未知类型就是代码 bug，重试没有意义
		q.log.Error("queue: 未注册的任务类型，直接置 dead", "type", typ, "id", id)
		q.markDead(finishCtx, id, instance, "unknown task type: "+typ)
		return
	}

	err := runHandler(ctx, h, payload)
	if err == nil {
		q.markDone(finishCtx, id, instance)
		return
	}
	msg := truncate(err.Error(), 1000)
	if errors.Is(err, queue.ErrSkipRetry) || errors.Is(err, context.Canceled) || attempts >= maxRetry {
		q.log.Warn("queue: 任务失败转 dead", "type", typ, "id", id, "attempts", attempts, "err", msg)
		q.markDead(finishCtx, id, instance, msg)
		return
	}
	q.log.Warn("queue: 任务失败将重试", "type", typ, "id", id, "attempts", attempts, "err", msg)
	q.retry(finishCtx, id, instance, msg)
}

// runHandler 必须 recover：一个 panic 不该让整个 worker 槽消失。
func runHandler(ctx context.Context, h queue.Handler, payload []byte) (err error) {
	defer func() {
		if r := recover(); r != nil {
			buf := make([]byte, 4096)
			n := runtime.Stack(buf, false)
			err = fmt.Errorf("panic: %v\n%s", r, buf[:n])
		}
	}()
	return h(ctx, payload)
}

func (q *Queue) markDone(ctx context.Context, id int64, instance string) {
	if _, err := q.pool.Exec(ctx, doneSQL, id, instance, q.clock.Now()); err != nil {
		q.log.Error("queue: 写回完成失败", "id", id, "err", err.Error())
	}
}

func (q *Queue) markDead(ctx context.Context, id int64, instance, msg string) {
	if _, err := q.pool.Exec(ctx, deadSQL, id, instance, msg, q.clock.Now()); err != nil {
		q.log.Error("queue: 写回 dead 失败", "id", id, "err", err.Error())
	}
}

func (q *Queue) retry(ctx context.Context, id int64, instance, msg string) {
	if _, err := q.pool.Exec(ctx, retrySQL, id, instance, msg, q.clock.Now(),
		q.cfg.BackoffBase.Seconds(), q.cfg.BackoffCap.Seconds()); err != nil {
		q.log.Error("queue: 写回重试失败", "id", id, "err", err.Error())
	}
}

// recoverLeases 把超租约的 running 收回。进程崩溃后靠它恢复。
func (q *Queue) recoverLeases(ctx context.Context) {
	tag, err := q.pool.Exec(ctx, recoverSQL, q.clock.Now())
	if err != nil {
		q.log.Warn("queue: 崩溃恢复失败", "err", err.Error())
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		q.log.Warn("queue: 收回超租约任务", "count", n)
	}
}

func (q *Queue) cleanup(ctx context.Context) {
	now := q.clock.Now()
	if tag, err := q.pool.Exec(ctx, cleanupDoneSQL, now.Add(-q.cfg.DoneKeep)); err != nil {
		q.log.Warn("queue: 清理 done 失败", "err", err.Error())
	} else if n := tag.RowsAffected(); n > 0 {
		q.log.Info("queue: 清理 done", "count", n)
	}
	if tag, err := q.pool.Exec(ctx, cleanupDeadSQL, now.Add(-q.cfg.DeadKeep)); err != nil {
		q.log.Warn("queue: 清理 dead 失败", "err", err.Error())
	} else if n := tag.RowsAffected(); n > 0 {
		q.log.Info("queue: 清理 dead", "count", n)
	}
}

// instanceID 只用于排查「这条任务被哪个进程领走了」；单实例部署下它是唯一标识。
func newInstanceID(c interface{ Now() time.Time }) string {
	return fmt.Sprintf("forum-%d", c.Now().UnixNano()%1e9)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
