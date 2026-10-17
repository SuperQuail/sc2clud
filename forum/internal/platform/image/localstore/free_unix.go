//go:build unix

package localstore

import "syscall"

// freeBytes 返回文件系统剩余可用字节。
// 这条闸门只做「快满了就别再收」，精确性不重要。
func freeBytes(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}
