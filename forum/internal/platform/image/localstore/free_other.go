//go:build !unix

package localstore

// freeBytes 在这些平台上不判：返回 **-1** 表示「这个平台量不出来」，Put 那侧把 -1 当作没有闸门。
//
// 为什么是 -1 而不是 0：Put 的判据是 `free >= 0 && free < minFreeBytes`，返回 0 会被读成
// 「磁盘真的空了」→ **这台机器（Windows）上任何带 minFreeBytes 的写入都报 media.disk_full**
// （2026-10-14 MIG-ART 实测：app 的 minFreeBytes=512MiB 让导入命令、以及所有图片上传全 500）。
// 与旧站 capacity.rs「量不出来就不拦」的语义一致。
func freeBytes(string) (int64, error) { return -1, nil }
