//go:build !unix

package localstore

// freeBytes 在这些平台上不判：返回 0 表示「这个平台没有闸门」，于是 Put 永远放行
// （Windows 开发机上 minFreeBytes 自动失效，与旧站 capacity.rs 的语义一致）。
func freeBytes(string) (int64, error) { return 0, nil }
