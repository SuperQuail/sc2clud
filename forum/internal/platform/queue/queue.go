// Package queue 是后台任务的接口。任务类型常量在 types.go。
// 实现只有一份：pgqueue（PostgreSQL jobs 表 + FOR UPDATE SKIP LOCKED）。
// 依据：d1-platform.md §6、v2 §7.4。
package queue

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ErrSkipRetry 由处理函数返回：不要重试，直接进 dead。
var ErrSkipRetry = errors.New("queue: skip retry")

// Task 是一次入队请求。RunAt 用零值表示立即执行。
type Task struct {
	Type      string
	Payload   any    // 会被序列化成 JSON；只放 id 这类最小形状，不放业务快照
	UniqueKey string // 可选：相同 key 的未完成任务只保留一个（部分唯一索引保证）
	RunAt     time.Time
	MaxRetry  int // 0 表示用默认值
	Priority  int // 越大越优先
}

// Handler 是任务处理函数。必须幂等：队列是至少一次投递。
type Handler func(ctx context.Context, payload []byte) error

// Queue 是入队侧。EnqueueTx 与业务数据同事务提交：事务回滚，任务也不存在。
type Queue interface {
	Enqueue(ctx context.Context, t Task) error
	EnqueueTx(ctx context.Context, tx TxExecutor, t Task) error
}

// Worker 是消费侧。
type Worker interface {
	Handle(taskType string, h Handler)
	// Run 收到 ctx 取消后等在途任务结束再返回。
	Run(ctx context.Context) error
}

// TxExecutor 是 EnqueueTx 需要的最小接口。
// 使用方定义接口（Go 的隐式接口），所以 queue 不需要 import ent。
// 注意：*ent.Tx 要有 ExecContext，ent 生成时必须开 sql/execquery 特性。
type TxExecutor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// MarshalPayload 把 payload 序列化成 JSON；nil 变成 {}（jobs.payload 是 NOT NULL）。
func MarshalPayload(v any) ([]byte, error) {
	if v == nil {
		return []byte("{}"), nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("queue: marshal payload: %w", err)
	}
	return b, nil
}
