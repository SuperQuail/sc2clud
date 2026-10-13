package auth

import (
	"context"
	"strconv"
	"sync"
	"time"

	"forum/internal/platform/clock"
)

// toucher 是 TouchAsync 的节流 + 批量刷写（设计 §6.5）。
//
// 为什么要它：每个请求都写 last_seen_at 会把 sessions 变成写热点。
// 节流窗口内的重复请求在**进程内**就被丢掉，请求路径上零写库。
type toucher struct {
	clk    clock.Clock
	ttl    time.Duration
	renew  time.Duration
	window time.Duration
	flush  func(ctx context.Context, pairs []TouchPair) error

	mu   sync.Mutex
	seen map[string]time.Time // digest(hex) → 上次写库的时刻
	ch   chan TouchPair
}

// maxTouchKeys 是节流表上限：超了整表清空重建——它只是写库频率的节流器，
// 清空只多写几次库（设计 §6.5 第 1 步）。
const maxTouchKeys = 10000

func newToucher(clk clock.Clock, window, renew, ttl time.Duration, flush func(context.Context, []TouchPair) error) *toucher {
	if window <= 0 {
		window = 10 * time.Minute
	}
	if renew <= 0 {
		renew = 24 * time.Hour
	}
	if ttl <= 0 {
		ttl = defaultSessionTTL
	}
	return &toucher{
		clk: clk, ttl: ttl, renew: renew, window: window, flush: flush,
		seen: make(map[string]time.Time),
		ch:   make(chan TouchPair, 1024),
	}
}

// TouchAsync 在请求路径上调用：非阻塞，满了就丢——丢掉的只是「在线时间不准」。
func (s *Service) TouchAsync(digest []byte) {
	t := s.touch
	now := t.clk.Now()
	key := strconv.FormatInt(int64(len(digest)), 10) + ":" + string(digest)

	t.mu.Lock()
	if last, ok := t.seen[key]; ok && now.Sub(last) < t.window {
		t.mu.Unlock()
		return
	}
	if len(t.seen) >= maxTouchKeys {
		t.seen = make(map[string]time.Time)
	}
	t.seen[key] = now
	t.mu.Unlock()

	select {
	case t.ch <- TouchPair{Digest: digest, Seen: now}:
	default:
	}
}

// run 每 500ms 或攒够 100 条刷一批；ctx 取消时把在途的写完再返回（关闭顺序第 2 步）。
func (t *toucher) run(ctx context.Context) error {
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	batch := make([]TouchPair, 0, 100)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		// 用 WithoutCancel：关闭流程里也要把最后一批写完
		if err := t.flush(context.WithoutCancel(ctx), batch); err != nil {
			// 丢掉的只是活跃时间，不值得打扰调用方
			_ = err
		}
		batch = batch[:0]
	}
	for {
		select {
		case <-ctx.Done():
			flush()
			return nil
		case p := <-t.ch:
			batch = append(batch, p)
			if len(batch) >= 100 {
				flush()
			}
		case <-tick.C:
			flush()
		}
	}
}
