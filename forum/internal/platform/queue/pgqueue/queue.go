// Package pgqueue 是任务队列的 PostgreSQL 实现。
// 领取用一条 UPDATE + FOR UPDATE SKIP LOCKED，多个 worker 并发领取互不阻塞。
// 依据：d1-platform.md §6、数据库文档 §4.10。
package pgqueue

import (
	"log/slog"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/config"
	"forum/internal/platform/clock"
	"forum/internal/platform/queue"
)

// Queue 同时实现 queue.Queue 与 queue.Worker：入队与消费共用同一份状态（wake channel）。
type Queue struct {
	pool  *pgxpool.Pool
	clock clock.Clock
	log   *slog.Logger
	cfg   config.Queue

	mu       sync.RWMutex
	handlers map[string]queue.Handler
	wake     chan struct{}
}

var (
	_ queue.Queue  = (*Queue)(nil)
	_ queue.Worker = (*Queue)(nil)
)

func New(pool *pgxpool.Pool, c clock.Clock, log *slog.Logger, cfg config.Queue) *Queue {
	return &Queue{
		pool:     pool,
		clock:    c,
		log:      log,
		cfg:      cfg,
		handlers: make(map[string]queue.Handler),
		wake:     make(chan struct{}, 1),
	}
}

func (q *Queue) Handle(taskType string, h queue.Handler) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.handlers[taskType] = h
}

func (q *Queue) handler(taskType string) (queue.Handler, bool) {
	q.mu.RLock()
	defer q.mu.RUnlock()
	h, ok := q.handlers[taskType]
	return h, ok
}

// signal 唤醒一个空转的 worker。带缓冲的 channel + 非阻塞发送：满了说明已经有人被唤醒。
func (q *Queue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}
