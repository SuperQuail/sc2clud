package app

import (
	"context"

	"forum/internal/platform/queue"
)

// registerTasks 把任务类型常量绑到处理函数。
// 类型常量在 platform/queue/types.go 一处定义；未注册的类型会被 worker 直接置 dead（那是代码 bug）。
// 各业务模块的 tasks.go 在 P1+ 把自己的处理函数挂到这里。
func registerTasks(in *Infra) {
	in.Worker.Handle(queue.TypeJobCleanup, func(ctx context.Context, _ []byte) error {
		// 清理本身也走队列：少一条独立的写路径，且天然被退避与幂等保护
		return nil
	})
}
