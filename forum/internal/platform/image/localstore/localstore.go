// Package localstore 是 image.Store 的唯一实现：本地磁盘 + 内容寻址。
//
// 依据：d5-content.md §1.1/§1.2。Put 的每一步都有对应测试（§11.1 第 1–4 条）。
package localstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"forum/internal/platform/image"
)

// Store 把内容写进 <root>/<ab>/<cd>/<sha256>。
type Store struct {
	root         string
	tmp          string
	minFreeBytes int64
}

// New 建目录并写一次探针：启动时就发现不可写，别等第一个上传。
// minFreeBytes 只在能判剩余空间的平台上生效（见 free_unix.go / free_other.go）。
func New(root string, minFreeBytes int64) (*Store, error) {
	s := &Store{root: root, tmp: filepath.Join(root, "tmp"), minFreeBytes: minFreeBytes}
	if err := os.MkdirAll(s.tmp, 0o755); err != nil {
		return nil, fmt.Errorf("image: 建目录 %s: %w", s.tmp, err)
	}
	probe := filepath.Join(s.tmp, ".probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return nil, fmt.Errorf("image: 根目录不可写 %s: %w", root, err)
	}
	if err := os.Remove(probe); err != nil {
		return nil, fmt.Errorf("image: 删探针 %s: %w", probe, err)
	}
	return s, nil
}

func (s *Store) path(h image.Hash) string {
	return filepath.Join(s.root, string(h)[:2], string(h)[2:4], string(h))
}

// Put 的步骤与顺序就是 d5 §1.2：预检 → 临时文件 → 边读边算 → 落盘 → fsync 文件与目录。
// 任何一步失败都删掉自己的临时文件，磁盘上不留残件。
func (s *Store) Put(ctx context.Context, r io.Reader, maxBytes int64) (image.Hash, int64, error) {
	if err := ctx.Err(); err != nil {
		return "", 0, err
	}
	if s.minFreeBytes > 0 {
		free, err := freeBytes(s.root)
		if err == nil && free >= 0 && free < s.minFreeBytes {
			return "", 0, image.ErrDiskFull
		}
	}
	f, err := os.CreateTemp(s.tmp, "*.part")
	if err != nil {
		return "", 0, fmt.Errorf("image: 建临时文件: %w", err)
	}
	tmp := f.Name()
	cleanup := func() {
		_ = f.Close()
		_ = os.Remove(tmp)
	}

	digest := sha256.New()
	// +1 字节：读到 maxBytes+1 就说明超了；于是「边读边算 + 超限即停」是一次遍历
	n, err := io.Copy(io.MultiWriter(f, digest), io.LimitReader(r, maxBytes+1))
	if err != nil {
		cleanup()
		return "", 0, fmt.Errorf("image: 读入: %w", err)
	}
	if n > maxBytes {
		cleanup()
		return "", 0, image.ErrTooLarge
	}
	if err := f.Sync(); err != nil {
		cleanup()
		return "", 0, fmt.Errorf("image: fsync: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return "", 0, fmt.Errorf("image: close: %w", err)
	}

	h := image.Hash(hex.EncodeToString(digest.Sum(nil)))
	final := s.path(h)
	// 已存在即去重：同摘要的内容逐字节相同，覆盖与忽略等价，不需要先 Stat（省一次系统调用与 TOCTOU）
	if _, err := os.Stat(final); err == nil {
		_ = os.Remove(tmp)
		return h, n, nil
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		_ = os.Remove(tmp)
		return "", 0, fmt.Errorf("image: 建目录: %w", err)
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", 0, fmt.Errorf("image: rename: %w", err)
	}
	// 只 fsync 文件不 fsync 目录时，掉电后可能出现「文件内容在、目录项不在」
	if err := syncDir(filepath.Dir(final)); err != nil {
		return "", 0, fmt.Errorf("image: fsync 目录: %w", err)
	}
	return h, n, nil
}

func (s *Store) Open(ctx context.Context, h image.Hash) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f, err := os.Open(s.path(h))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, image.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("image: open %s: %w", h, err)
	}
	return f, nil
}

func (s *Store) Stat(ctx context.Context, h image.Hash) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	st, err := os.Stat(s.path(h))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, image.ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("image: stat %s: %w", h, err)
	}
	return st.Size(), nil
}

// Delete 幂等：文件不在就是目标态（GC 会重复调用它）。
func (s *Store) Delete(ctx context.Context, h image.Hash) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Remove(s.path(h)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("image: delete %s: %w", h, err)
	}
	return nil
}

// Walk 遍历 <root>/<ab>/<cd>/<hash> 三层下的所有文件，跳过 tmp/。
func (s *Store) Walk(ctx context.Context, fn func(image.Hash) error) error {
	dirs, err := os.ReadDir(s.root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("image: walk root: %w", err)
	}
	for _, d := range dirs {
		if !d.IsDir() || d.Name() == "tmp" || len(d.Name()) != 2 {
			continue
		}
		if err := s.walkLevel(ctx, filepath.Join(s.root, d.Name()), fn); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) walkLevel(ctx context.Context, dir string, fn func(image.Hash) error) error {
	subs, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("image: walk %s: %w", dir, err)
	}
	for _, sub := range subs {
		if !sub.IsDir() || len(sub.Name()) != 2 {
			continue
		}
		files, err := os.ReadDir(filepath.Join(dir, sub.Name()))
		if err != nil {
			return fmt.Errorf("image: walk %s: %w", dir, err)
		}
		for _, f := range files {
			if err := ctx.Err(); err != nil {
				return err
			}
			name := f.Name()
			if f.IsDir() || strings.HasPrefix(name, ".") || !isHash(name) {
				continue
			}
			if err := fn(image.Hash(name)); err != nil {
				return err
			}
		}
	}
	return nil
}

// isHash 判「长得像我们的 hash」：64 位小写 hex。残件（*.part）与别的文件都不算。
func isHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
