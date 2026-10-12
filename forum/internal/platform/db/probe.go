package db

import (
	"context"
	"fmt"
	"os"
)

// Ping 给 /readyz 用：超时由调用方给。
func Ping(ctx context.Context, p interface{ Ping(context.Context) error }) error {
	if err := p.Ping(ctx); err != nil {
		return fmt.Errorf("db ping: %w", err)
	}
	return nil
}

// WriteProbe 验证目录可写：建一个随机名文件再删掉。
// 启动时做一次就够——每次 /readyz 都写磁盘没有必要，也不该有副作用。
func WriteProbe(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	f, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return fmt.Errorf("create in %s: %w", dir, err)
	}
	name := f.Name()
	if err := f.Close(); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("close probe: %w", err)
	}
	if err := os.Remove(name); err != nil {
		return fmt.Errorf("remove probe: %w", err)
	}
	return nil
}
