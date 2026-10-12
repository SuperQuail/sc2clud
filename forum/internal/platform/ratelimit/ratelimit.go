// Package ratelimit 是跨进程一致的限流。
// 语义：在 window 时间内最多允许 limit 次；被拒时给出建议等待时间。
package ratelimit

import (
	"context"
	"time"
)

type RateLimiter interface {
	Allow(ctx context.Context, key string, limit int, window time.Duration) (ok bool, retryAfter time.Duration, err error)
}
