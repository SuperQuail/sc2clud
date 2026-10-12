// Package app 是组装层：整个项目里唯一知道所有模块的地方。
// 手工组装，没有 DI 容器；每个组件通过构造函数拿依赖，禁止全局变量与 init()。
package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"

	"entgo.io/ent"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"forum/internal/config"
	"forum/internal/platform/clock"
	"forum/internal/platform/counter"
	"forum/internal/platform/counter/pgcounter"
	"forum/internal/platform/db"
	"forum/internal/platform/kv"
	"forum/internal/platform/kv/memkv"
	"forum/internal/platform/kv/rediskv"
	"forum/internal/platform/queue"
	"forum/internal/platform/queue/pgqueue"
	"forum/internal/platform/ratelimit"
	"forum/internal/platform/ratelimit/memlimit"
	"forum/internal/platform/ratelimit/redislimit"
)

// Infra 是基础设施。只有本来就属于平台层的东西在这里；
// 业务模块（mail / image / search / captcha）由各自的 P 阶段挂上来。
type Infra struct {
	DB      *ent.Client
	Pool    *pgxpool.Pool
	Tx      TxFunc
	Cache   kv.Cache
	Limiter ratelimit.RateLimiter
	Queue   queue.Queue
	Worker  queue.Worker
	Counter *counter.Buffer
	Clock   clock.Clock
	Log     *slog.Logger

	// Profile 是生效的容量档位（small / standard），决定 worker 并发等参数。
	Profile string

	closers []func() error
}

// TxFunc 是 db.WithTx 的绑定形态：业务模块拿到它就能开事务，不必自己 import ent 的 client。
type TxFunc func(ctx context.Context, fn func(tx *ent.Tx) error) error

// NewInfra 创建全部基础设施。任何一步失败：先关掉已经建好的，再返回错误（启动即失败）。
func NewInfra(ctx context.Context, cfg *config.Config, log *slog.Logger) (*Infra, error) {
	in := &Infra{Clock: clock.Real{}, Log: log}

	profile := cfg.Capacity.Resolve(memoryLimit())
	in.Profile = profile
	log.Info("容量档位", "profile", profile, "memory_limit_bytes", memoryLimit(),
		"db_max_conns", cfg.DB.MaxConns, "queue_workers", cfg.Queue.WorkersFor(profile))

	client, pool, err := db.Open(ctx, cfg.DB)
	if err != nil {
		return nil, err
	}
	in.DB, in.Pool = client, pool
	in.Tx = func(ctx context.Context, fn func(tx *ent.Tx) error) error {
		return db.WithTx(ctx, in.DB, fn)
	}
	// 先 client 再 pool
	in.closers = append(in.closers,
		func() error { pool.Close(); return nil }, // 先入后出：池最后关
		client.Close,
	)

	rdb, cache, limiter, err := openKV(ctx, cfg)
	if err != nil {
		in.Close()
		return nil, err
	}
	in.Cache, in.Limiter = cache, limiter
	if rdb != nil {
		in.closers = append(in.closers, func() error { return rdb.Close() })
	}

	q := pgqueue.New(pool, in.Clock, log, cfg.Queue)
	in.Queue, in.Worker = q, q

	in.Counter = counter.New(log, pgcounter.New(pool, in.Clock).Flush)

	// 图片根目录：启动时写一次探针，别等第一个上传才发现不可写
	if err := db.WriteProbe(cfg.Image.Root); err != nil {
		in.Close()
		return nil, fmt.Errorf("image.root 不可写: %w", err)
	}
	return in, nil
}

// openKV 按 kv.driver 建缓存与限流。Redis 与 memory 共用一个连接（redis 分支）。
func openKV(ctx context.Context, cfg *config.Config) (*redis.Client, kv.Cache, ratelimit.RateLimiter, error) {
	switch cfg.KV.Driver {
	case "redis":
		rdb := redis.NewClient(&redis.Options{
			Addr:         cfg.KV.Addr,
			Password:     cfg.KV.Password,
			DB:           cfg.KV.DB,
			DialTimeout:  cfg.KV.DialTimeout,
			ReadTimeout:  cfg.KV.ReadTimeout,
			WriteTimeout: cfg.KV.WriteTimeout,
		})
		pingCtx, cancel := context.WithTimeout(ctx, cfg.KV.DialTimeout)
		defer cancel()
		if err := rdb.Ping(pingCtx).Err(); err != nil {
			_ = rdb.Close()
			return nil, nil, nil, fmt.Errorf("kv: redis ping %s: %w", cfg.KV.Addr, err)
		}
		return rdb, rediskv.New(rdb), redislimit.New(rdb), nil
	case "memory":
		return nil, memkv.New(10000), memlimit.New(10000), nil
	default:
		return nil, nil, nil, fmt.Errorf("kv: 未知 driver %q", cfg.KV.Driver)
	}
}

// Close 倒序关闭：先建的最后关（池最后关，因为 worker 还在写库）。
func (in *Infra) Close() {
	var errs []error
	for i := len(in.closers) - 1; i >= 0; i-- {
		if err := in.closers[i](); err != nil {
			errs = append(errs, err)
		}
	}
	if err := errors.Join(errs...); err != nil {
		in.Log.Warn("infra: 关闭时有错误", "err", err.Error())
	}
	in.closers = nil
}

// memoryLimit 读 cgroup / proc 的内存上限，读不到返回 0（决议档位的 fallback 由 Resolve 处理）。
func memoryLimit() uint64 {
	if b, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		if n, ok := parseBytes(strings.TrimSpace(string(b))); ok {
			return n
		}
	}
	if f, err := os.Open("/proc/meminfo"); err == nil {
		defer func() { _ = f.Close() }()
		if data, err := io.ReadAll(io.LimitReader(f, 4096)); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "MemTotal:") {
					fields := strings.Fields(line)
					if len(fields) >= 2 {
						if n, ok := parseBytes(fields[1] + "kB"); ok {
							return n
						}
					}
				}
			}
		}
	}
	return 0
}

// parseBytes 解析 "4G" / "1073741824" / "16384000kB" 这类值。
func parseBytes(s string) (uint64, bool) {
	mult := uint64(1)
	switch {
	case strings.HasSuffix(s, "kB"):
		s, mult = strings.TrimSuffix(s, "kB"), 1024
	case strings.HasSuffix(s, "MB"):
		s, mult = strings.TrimSuffix(s, "MB"), 1024*1024
	case strings.HasSuffix(s, "GB"):
		s, mult = strings.TrimSuffix(s, "GB"), 1024*1024*1024
	case strings.HasSuffix(s, "max"):
		return 0, false
	}
	var n uint64
	if _, err := fmt.Sscanf(strings.TrimSpace(s), "%d", &n); err != nil {
		return 0, false
	}
	return n * mult, true
}
