// Package clock 是时间的唯一来源。业务代码禁止直接调用 time.Now()。
package clock

import "time"

// Clock 只要一个方法：测试里能控制时间就够了，不需要「自动前进」「时间旅行」。
type Clock interface {
	Now() time.Time
}

// Real 是生产实现。时间一律 UTC——入库、出参、比较都不带本地时区。
type Real struct{}

func (Real) Now() time.Time { return time.Now().UTC() }

// Fake 是测试实现。值语义：同一个 Fake 变量被多处引用时共享同一个时间点。
type Fake struct {
	T time.Time
}

func (f *Fake) Now() time.Time { return f.T }
