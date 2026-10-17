// Package redislimit 是限流的 Redis 实现：固定窗口 + 一条 Lua（一次往返完成 INCR 与首次 EXPIRE）。
// 固定窗口而不是滑动窗口：实现小、语义够用，不需要额外存储。
package redislimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// INCR 与 EXPIRE 必须在一条 Lua 里：否则进程在两条命令之间挂掉会留下永不过期的 key，把该 key 永久锁死。
var windowScript = redis.NewScript(`
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('PTTL', KEYS[1])
if n > tonumber(ARGV[1]) then return {0, ttl} end
return {1, ttl}
`)

type Limiter struct {
	rdb *redis.Client
}

func New(rdb *redis.Client) *Limiter { return &Limiter{rdb: rdb} }

func (l *Limiter) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, time.Duration, error) {
	if limit <= 0 || window <= 0 {
		return true, 0, nil
	}
	res, err := windowScript.Run(ctx, l.rdb, []string{key}, limit, window.Milliseconds()).Slice()
	if err != nil {
		// Redis 不可用 = 拒绝放行（安全优先）。错误原样上抛，由中间件转成 429。
		return false, 0, fmt.Errorf("ratelimit %s: %w", key, err)
	}
	if len(res) != 2 {
		return false, 0, fmt.Errorf("ratelimit %s: unexpected script reply", key)
	}
	ok := toInt(res[0]) == 1
	ttlMS := toInt(res[1])
	if ttlMS < 0 {
		ttlMS = 0
	}
	return ok, time.Duration(ttlMS) * time.Millisecond, nil
}

func toInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	default:
		return 0
	}
}
