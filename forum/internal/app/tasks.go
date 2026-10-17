package app

import (
	"context"
	"errors"
	"fmt"
	"strconv"
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
	w.Handle(queue.TypeAIReview, m.reviewTopic)
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

// reviewTopic 处理 ai:review。payload 有两种形状，**同一个任务类型**（不新增类型）：
//
//	{"topic_id": <bigint>, "trigger": "create"|"report"|"edit"}  —— 主题
//	{"issue_id": <bigint>, "trigger": "report"}                  —— Issue（0062_issue_archive）
//
// edit 来自**编辑正文**：UpdateTopic 把改动存进待审槽后入队一条（forum/topics.go 的 UpdateTopic）。
// Issue 只有 report 一种触发（举报到阈值），所以那条分支恒走 ReviewIssue。
//
// 任务的返回值就是「要不要重试」：网络 / 5xx / 429 这类 return err 交给队列退避（max_retry=2 之后进 dead，
// 内容留在原状态交人工）；解析失败与「拿不准」都是成功返回 —— 重试也是同样的结果。
func (m *Modules) reviewTopic(ctx context.Context, payload []byte) error {
	var p struct {
		TopicID int64  `json:"topic_id"`
		IssueID int64  `json:"issue_id"`
		Trigger string `json:"trigger"`
	}
	if err := unmarshalPayload(payload, &p); err != nil {
		return queue.ErrSkipRetry // payload 是我们自己写的：解不出就是代码 bug
	}
	if p.IssueID > 0 {
		// Issue 判定**不补 search:index**：Issue 不进搜索索引（search:index 只服务主题），
		// 那条补索引的链路（reviewThenIndex）对它是纯粹的无效负载。
		return m.AIReview.ReviewIssue(ctx, p.IssueID, p.Trigger)
	}
	if p.TopicID <= 0 {
		return queue.ErrSkipRetry
	}
	return reviewThenIndex(ctx, m.AIReview.ReviewTopic, m.in.Queue.Enqueue, p.TopicID, p.Trigger)
}

// reviewThenIndex 跑一次 AI 判定；判定成功后**补一条 search:index**。
//
// 为什么非补不可：indexTopic（上面）对「未过审」的主题是把索引行**删掉**，而 search:index
// 只由发帖 / 改帖 / 删帖入队。人工放行在 forum/review_queue.go（放行那一刻自己补了一条），
// 而 AI 判定跑在 pgx.Tx 里、够不到 ent 事务（跨包跨驱动），它补不了 —— 只能由这里补，
// 这是 AI 放行链路上唯一的事务外落点。少了这一步，AI 放行的帖（create 放行、edit 放行）
// 在搜索里**永远**不存在，直到下一次编辑 / 删除把它重新入队（create 那条是 D63 把 AI 审核
// 默认打开之后就存在的既有缺口）。
//
// 判定没成功（err != nil）就不补：那条任务会退避重试，重建留给重试成功的那一次。
// 队列对同 key 会去重（人工那条路 / 重复判定多排一次也只是幂等重建），而入队失败原样返回 ——
// 任务重试时判定与补索引一起再来一次。
func reviewThenIndex(ctx context.Context, review func(context.Context, int64, string) error, enqueue func(context.Context, queue.Task) error, topicID int64, trigger string) error {
	if err := review(ctx, topicID, trigger); err != nil {
		return err
	}
	return enqueue(ctx, queue.Task{
		Type: queue.TypeSearchIndex, Payload: map[string]int64{"id": topicID},
		UniqueKey: "topic:" + strconv.FormatInt(topicID, 10),
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
