// Package kv 是按用途定义的小缓存接口，不做「模拟 Redis」的大接口。
package kv

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound 表示未命中。调用方据此回源。
var ErrNotFound = errors.New("kv: not found")

// ErrUnavailable 表示后端连不上。缓存类调用方把它当成未命中（回源）；
// 限流类调用方必须拒绝放行（Redis 故障不放行刷子）。
var ErrUnavailable = errors.New("kv: unavailable")

// Cache 的值统一是 []byte，序列化由调用方负责，接口里不出现任何具体实现类型。
type Cache interface {
	// Get 未命中返回 ErrNotFound，后端不可用返回 ErrUnavailable。
	Get(ctx context.Context, key string) ([]byte, error)
	// Set 的 ttl 必须大于 0。
	Set(ctx context.Context, key string, val []byte, ttl time.Duration) error
	Del(ctx context.Context, keys ...string) error
}
