// Package rediskv 是 kv.Cache 的 Redis 实现。
// Redis 故障时返回 kv.ErrUnavailable，调用方按「回源查库」处理（缓存丢了没关系）。
package rediskv

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"forum/internal/platform/kv"
)

type Cache struct {
	rdb *redis.Client
}

func New(rdb *redis.Client) *Cache { return &Cache{rdb: rdb} }

func (c *Cache) Get(ctx context.Context, key string) ([]byte, error) {
	b, err := c.rdb.Get(ctx, key).Bytes()
	switch {
	case errors.Is(err, redis.Nil):
		return nil, kv.ErrNotFound
	case err != nil:
		return nil, fmt.Errorf("kv get %s: %w", key, kv.ErrUnavailable)
	}
	return b, nil
}

func (c *Cache) Set(ctx context.Context, key string, val []byte, ttl time.Duration) error {
	if err := c.rdb.Set(ctx, key, val, ttl).Err(); err != nil {
		return fmt.Errorf("kv set %s: %w", key, kv.ErrUnavailable)
	}
	return nil
}

func (c *Cache) Del(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	if err := c.rdb.Del(ctx, keys...).Err(); err != nil {
		return fmt.Errorf("kv del: %w", kv.ErrUnavailable)
	}
	return nil
}
