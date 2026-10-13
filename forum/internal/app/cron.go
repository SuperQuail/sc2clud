package app

import (
	"context"
	"time"

	"forum/internal/platform/queue"
)

// runCron 是定时入队器：它只负责「该产生任务了」，业务逻辑全在处理函数里
// （queue:cleanup 的处理函数在 tasks.go：通知 / 私信清理、会话与令牌清理、图片 GC 入队）。
// ctx 取消后等本轮结束（备份的临时文件要清掉）再返回（关闭顺序第 3 步）。
func runCron(ctx context.Context, in *Infra) error {
	cleanup := time.NewTicker(time.Hour)
	// AI 发帖审核：没配 key 时 reviewPending 直接返回（一个外呼都不发）。
	reviewEvery := in.AI.Interval
	if reviewEvery <= 0 {
		reviewEvery = 2 * time.Minute
	}
	review := time.NewTicker(reviewEvery)
	defer review.Stop()
	defer cleanup.Stop()
	// 启动时先跑一轮清理：重启后的第一个小时不该攒着过期行
	if err := enqueueCleanup(ctx, in); err != nil {
		in.Log.Warn("cron: 入队 queue:cleanup 失败", "err", err.Error())
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-cleanup.C:
			if err := enqueueCleanup(ctx, in); err != nil {
				in.Log.Warn("cron: 入队 queue:cleanup 失败", "err", err.Error())
			}
		case <-review.C:
			if err := reviewPending(ctx, in); err != nil {
				in.Log.Warn("cron: AI 审核失败", "err", err.Error())
			}
		}
	}
}

func enqueueCleanup(ctx context.Context, in *Infra) error {
	return in.Queue.Enqueue(ctx, queue.Task{
		Type:      queue.TypeJobCleanup,
		UniqueKey: queue.TypeJobCleanup,
	})
}
