// Package memlimit 是进程内限流，仅供本地开发与 CI（多实例下各算各的，配置校验禁止 production 用它）。
package memlimit

import (
	"context"
	"sync"
	"time"
)

type window struct {
	start time.Time
	n     int
}

// Limiter 用固定窗口计数。key 数量有硬上限，超了整体清空——限流器不该是内存泄漏源。
type Limiter struct {
	mu  sync.Mutex
	m   map[string]*window
	max int
	now func() time.Time
}

func New(maxKeys int) *Limiter {
	if maxKeys <= 0 {
		maxKeys = 10000
	}
	return &Limiter{m: make(map[string]*window, maxKeys), max: maxKeys, now: time.Now}
}

func (l *Limiter) Allow(_ context.Context, key string, limit int, win time.Duration) (bool, time.Duration, error) {
	if limit <= 0 || win <= 0 {
		return true, 0, nil
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.m) >= l.max {
		l.m = make(map[string]*window)
	}
	w, ok := l.m[key]
	if !ok || now.Sub(w.start) >= win {
		l.m[key] = &window{start: now, n: 1}
		return true, 0, nil
	}
	w.n++
	if w.n > limit {
		return false, w.start.Add(win).Sub(now), nil
	}
	return true, 0, nil
}
