// Package image 是图片字节的唯一入口：内容寻址、四格式白名单、磁盘闸门。
//
// 依据：d5-content.md §1、交接单 §1.1。
// 布局 <root>/<ab>/<cd>/<sha256>，ab/cd 是摘要前四位；tmp/ 是写入中的临时文件。
package image

import (
	"context"
	"errors"
	"io"
)

var (
	ErrNotFound = errors.New("image: not found")
	ErrTooLarge = errors.New("image: too large")
	ErrBadType  = errors.New("image: bad type")
	ErrDiskFull = errors.New("image: disk full")
)

// Hash 是长度恒为 64 的小写 hex sha256。它同时是主键与对外标识（URL 形状 /img/<hash>）。
type Hash string

// Store 只有五个方法：Put / Open / Stat / Delete / Walk。
// 没有 Exists——它在去重路径上省不掉一次打开，只会多一个要维护的方法（d5 §1.1）。
type Store interface {
	// Put 边读边算 sha256，最多收 maxBytes 字节；超限返回 ErrTooLarge 且不落盘。
	// 内容已存在时直接返回（去重），不重写文件。
	Put(ctx context.Context, r io.Reader, maxBytes int64) (Hash, int64, error)
	Open(ctx context.Context, h Hash) (io.ReadCloser, error)
	Stat(ctx context.Context, h Hash) (int64, error)
	Delete(ctx context.Context, h Hash) error
	// Walk 遍历磁盘上的 hash（image:gc 用它找「有文件没行」的孤儿）。
	Walk(ctx context.Context, fn func(Hash) error) error
}
