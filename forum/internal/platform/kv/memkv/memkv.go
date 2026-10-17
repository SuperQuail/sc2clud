// Package memkv 是进程内缓存：只用于本地开发与 CI（配置校验禁止 production 用它）。
package memkv

import (
	"context"
	"sync"
	"time"

	"forum/internal/platform/kv"
)

type entry struct {
	val []byte
	exp time.Time
}

// Cache 是有硬上限的进程内缓存：无上限的 map 就是一个内存泄漏。
type Cache struct {
	mu      sync.Mutex
	m       map[string]entry
	maxKeys int
}

// New 创建进程内缓存。maxKeys<=0 时取 10000。
func New(maxKeys int) *Cache {
	if maxKeys <= 0 {
		maxKeys = 10000
	}
	return &Cache{m: make(map[string]entry), maxKeys: maxKeys}
}

func (c *Cache) Get(_ context.Context, key string) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok {
		return nil, kv.ErrNotFound
	}
	if time.Now().After(e.exp) {
		delete(c.m, key)
		return nil, kv.ErrNotFound
	}
	return e.val, nil
}

func (c *Cache) Set(_ context.Context, key string, val []byte, ttl time.Duration) error {
	if ttl <= 0 {
		return kv.ErrUnavailable
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= c.maxKeys {
		// 淘汰第一个过期的；没有过期的就整体清空（缓存丢了没关系）
		now := time.Now()
		for k, e := range c.m {
			if now.After(e.exp) {
				delete(c.m, k)
			}
		}
		if len(c.m) >= c.maxKeys {
			c.m = make(map[string]entry)
		}
	}
	cp := make([]byte, len(val))
	copy(cp, val)
	c.m[key] = entry{val: cp, exp: time.Now().Add(ttl)}
	return nil
}

func (c *Cache) Del(_ context.Context, keys ...string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, k := range keys {
		delete(c.m, k)
	}
	return nil
}
