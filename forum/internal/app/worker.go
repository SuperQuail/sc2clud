package app

import (
	"context"
)

// runWorker 起队列消费循环。ctx 取消后等在途任务结束再返回（关闭顺序第 2 步）。
func runWorker(ctx context.Context, in *Infra) error {
	return in.Worker.Run(ctx)
}
