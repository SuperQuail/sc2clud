//go:build !unix

package localstore

import "os"

// syncDir 在非 unix 平台上退化成打开再关闭：Windows 不允许对目录句柄 fsync，
// 而 ntfs 的 rename 语义已经保证了目录项的可见性。
func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	return f.Close()
}
