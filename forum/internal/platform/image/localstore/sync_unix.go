//go:build unix

package localstore

import (
	"os"
	"syscall"
)

// syncDir 让目录项落盘：只 fsync 文件时，掉电后可能「文件内容在、目录项不在」。
func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if err := f.Sync(); err != nil {
		// 有些文件系统不支持目录 fsync（EINVAL）：那不是数据丢失，放行
		if err == syscall.EINVAL {
			return nil
		}
		return err
	}
	return nil
}
