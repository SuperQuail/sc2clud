package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"forum/internal/media"
	"forum/internal/notify"
	"forum/internal/platform/queue"
	"forum/internal/platform/search"
)

// purgeRetention 是通知 / 私信软删行的保留期（d4 §5.5：90 天）。
const purgeRetention = 90 * 24 * time.Hour

// purgeBatch 是一次清理最多删的行数（设计 §5.5：分批，长事务会挡 autovacuum）。
const purgeBatch = 5000

// pruneGrace 是「已过期多久」才真删会话 / 令牌 / 过期权限的宽限期（设计 §5.2：7 天）。
const pruneGrace = 7 * 24 * time.Hour

// registerTasks 把**全部**任务类型绑到处理函数。一个都不能漏：
// worker 遇到没注册的类型会直接把它置 dead，而 dead 任务不会自己回来
// （上线设计 §2 P1 决策 4）。
func registerTasks(in *Infra, m *Modules) {
	w := in.Worker

	// 通知六类（d4 §5.1 ①②③④⑤⑥）：payload 是共用的 CreateNotifyInput，
	// 类别由任务类型决定，不放进 payload。
	for taskType, handle := range map[string]func(context.Context, notify.CreateNotifyInput) error{
		queue.TypeNotifyReply:    m.Notify.NotifyReply,
		queue.TypeNotifyMention:  m.Notify.NotifyMention,
		queue.TypeNotifyLike:     m.Notify.NotifyLike,
		queue.TypeNotifyReward:   m.Notify.NotifyReward,
		queue.TypeNotifyReview:   m.Notify.NotifyReview,
		queue.TypeNotifySanction: m.Notify.NotifySanction,
	} {
		w.Handle(taskType, notifyHandler(handle))
	}

	w.Handle(queue.TypeMailSend, m.Mail.HandleMailSend)
	w.Handle(queue.TypeSearchIndex, m.indexTopic)
	w.Handle(queue.TypeImageGC, m.Media.GCImages)
	w.Handle(queue.TypeJobCleanup, m.cleanup)
}

// notifyHandler 解 payload 再交给域的处理函数。
// payload 是我们自己写的（queue.Task.Payload）：解不出就是代码 bug，重试多少次都一样。
func notifyHandler(fn func(context.Context, notify.CreateNotifyInput) error) queue.Handler {
	return func(ctx context.Context, payload []byte) error {
		in, err := notify.ParsePayload(payload)
		if err != nil {
			return queue.ErrSkipRetry
		}
		return fn(ctx, in)
	}
}

// indexTopic 处理 search:index（forum 在发帖 / 改帖 / 删帖的事务里入队）。
//
// 它没有自己的域：索引写入是 platform/search 的事，而「取哪个主题的哪段正文」用的
// 是 forum/pgsql 已有的查询（app 层不写原生 SQL）。任务只带 {"id": topic id}。
func (m *Modules) indexTopic(ctx context.Context, payload []byte) error {
	var p struct {
		ID int64 `json:"id"`
	}
	if err := unmarshalPayload(payload, &p); err != nil || p.ID <= 0 {
		return queue.ErrSkipRetry
	}
	index := m.searchIndex()
	ref, err := m.fstore.TopicRefByID(ctx, p.ID)
	if err != nil {
		// 主题被硬删了：索引行留着也没用（查询 JOIN topics），清掉后当完成
		if isNoRows(err) {
			return index.DeleteTopic(ctx, p.ID)
		}
		return err
	}
	if ref.Visibility != "normal" || ref.ReviewState != "approved" {
		// 隐藏 / 未过审的主题不进索引：可见性由 SQL 再过滤一遍，但清掉更省空间
		return index.DeleteTopic(ctx, p.ID)
	}
	card, err := m.fstore.TopicCard(ctx, ref.ID)
	if err != nil {
		return err
	}
	body := ""
	// 1 楼就是正文（forum 建主题与建回复用的是同一张 posts 表）。
	if postID, err := m.fstore.PostIDByFloor(ctx, ref.ID, 1); err == nil {
		if post, err := m.fstore.PostByID(ctx, postID, 0); err == nil {
			body = search.PlainText(post.ContentHTML)
		} else if !isNoRows(err) {
			return err
		}
	} else if !isNoRows(err) {
		return err
	}
	// tokens 与查询侧共用 search.Tokenize —— 两边必须是同一个函数，否则搜不到。
	return index.UpsertTopic(ctx, search.TopicDoc{
		TopicID: ref.ID, Title: card.Title, BodyText: body,
		Tokens: search.Tokenize(card.Title + " " + body),
	})
}

// cleanup 处理 queue:cleanup（cron 每小时入队一次，启动时先跑一轮）。
//
// 这些活没有各自的业务触发点：过期行清理不是正确性要求（查询本来就过滤），
// 只是防表变胖，所以挂在同一个清理任务上（d4 §5.5 / d1 §5.2）。
// 单条失败不中断其余：它们互不依赖，一条失败不该让别的也停。
func (m *Modules) cleanup(ctx context.Context, _ []byte) error {
	now := m.in.Clock.Now()
	var errs []error
	step := func(what string, fn func() (int, error)) {
		n, err := fn()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", what, err))
			return
		}
		if n > 0 {
			m.in.Log.Info("cleanup: 清理完成", "what", what, "rows", n)
		}
	}

	step("notify.purge", func() (int, error) { return m.Notify.Purge(ctx, now.Add(-purgeRetention), purgeBatch) })
	step("message.purge", func() (int, error) { return m.Message.Purge(ctx, now.Add(-purgeRetention), purgeBatch) })
	step("auth.sessions", func() (int, error) { return m.Auth.PruneSessions(ctx, now.Add(-pruneGrace)) })
	step("auth.email_tokens", func() (int, error) { return m.Auth.PruneEmailTokens(ctx, now.Add(-pruneGrace)) })
	step("auth.expired_grants", func() (int, error) { return m.Auth.PruneExpiredGrants(ctx, now.Add(-pruneGrace)) })

	// 图片 GC 自己是一个任务（media 的），这里只负责入队：让「扫盘」不占清理任务的时长。
	// UniqueKey 由 media 那边给：同一时刻只有一个待执行的 GC。
	if err := media.EnqueueImageGC(ctx, m.in.Queue); err != nil {
		errs = append(errs, fmt.Errorf("image.gc 入队: %w", err))
	}
	return errors.Join(errs...)
}
