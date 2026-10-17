package media

import (
	"context"

	"forum/internal/platform/queue"
)

// RegisterTasks 把本模块的任务处理函数挂到 worker 上。app 层：media.RegisterTasks(in.Worker, mediaSvc)
func RegisterTasks(w interface {
	Handle(taskType string, h queue.Handler)
}, svc *Service) {
	w.Handle(queue.TypeImageGC, svc.GCImages)
}

// EnqueueImageGC 是 cron 侧的入队（daily）。UniqueKey 保证同一时刻只有一个待执行的 GC。
func EnqueueImageGC(ctx context.Context, q interface {
	Enqueue(ctx context.Context, t queue.Task) error
}) error {
	return q.Enqueue(ctx, queue.Task{
		Type:      queue.TypeImageGC,
		UniqueKey: queue.TypeImageGC,
	})
}
