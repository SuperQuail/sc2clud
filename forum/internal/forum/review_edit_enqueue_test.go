package forum

import (
	"testing"

	"forum/internal/authz"
	"forum/internal/platform/queue"
)

// 「改过正文就重新过一遍审核」这条链路是本轮接上的（2026-10-16）。
//
// 旧行为：UpdateTopic 只投 search:index，作者的新正文进待审槽（topic_revisions.pending_md）
// 之后**队列里一条 AI 任务都没有** —— 改动只能等人工，AI 永远看不到它。
//
// 三条断言分别钉：已过审的帖（n>0，改动进待审槽）、从没过审的帖（n==0，正文直接进 posts）、
// 以及只改标题/分区**不该**惊动 AI（那是分类问题，不是内容变更）。
func TestEditingBodyEnqueuesAIReview(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermPostReview)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1"})
	if d.ReviewState != "approved" {
		t.Fatalf("前提不成立：trusted + post.review 的作者该直接过审，实际 %s", d.ReviewState)
	}
	h.queue.reset() // 发帖那条路上的 ai:review（trigger=create）不属于本用例

	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V2")}); err != nil {
		t.Fatal(err)
	}
	tasks := h.queue.tasksOf(queue.TypeAIReview)
	if len(tasks) != 1 {
		t.Fatalf("改正文该入队一条 AI 审核，实际 %d 条（队列里：%v）", len(tasks), h.queue.types())
	}
	task := tasks[0]
	if task.Priority != 20 || task.MaxRetry != 2 {
		t.Fatalf("任务形状不对: %+v", task)
	}
	id := h.topicID(t, d.ID)
	if want := "review:edit:" + itoa64(id); task.UniqueKey != want {
		t.Fatalf("unique_key=%q，要 %q", task.UniqueKey, want)
	}
	payload, _ := task.Payload.(map[string]any)
	if payload["topic_id"] != id || payload["trigger"] != "edit" {
		t.Fatalf("payload=%v（要 topic_id=%d / trigger=edit）", task.Payload, id)
	}
	// 搜索索引照旧要投：两条任务在**同一个事务**里（回滚则任务不存在，拍板 §5.4）。
	if n := len(h.queue.tasksOf(queue.TypeSearchIndex)); n != 1 {
		t.Fatalf("search:index 也该投一条，实际 %d 条", n)
	}

	// 从没过审的帖（pending）：正文本来就写进 posts（n==0 那一支），同样要重审 ——
	// 少了这一条，作者改完自己的待审帖就永远等不到 AI 的第二次意见。
	plain, _ := h.author("bob", 5, false, authz.PermTopicCreate, authz.PermTopicEditOwn)
	p := h.mustTopic(plain, CreateTopicInput{BoardSlug: "general", Title: "新帖", ContentMD: "D1"})
	if p.ReviewState != "pending" {
		t.Fatalf("前提不成立：未 trusted 的作者该进待审，实际 %s", p.ReviewState)
	}
	h.queue.reset()
	if err := h.svc.UpdateTopic(h.ctx, plain, p.ID, UpdateTopicInput{ContentMD: ptrStr("D2")}); err != nil {
		t.Fatal(err)
	}
	if n := len(h.queue.tasksOf(queue.TypeAIReview)); n != 1 {
		t.Fatalf("待审帖改正文也要重新审，实际 %d 条", n)
	}

	// 只改标题：不入队（in.ContentMD 为 nil）。
	h.queue.reset()
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{Title: ptrStr("新标题")}); err != nil {
		t.Fatal(err)
	}
	if n := len(h.queue.tasksOf(queue.TypeAIReview)); n != 0 {
		t.Fatalf("只改标题 / 分区不该重新审正文，实际 %d 条", n)
	}
}

// topicID 是对外 id → 内部 id 的换算（任务 payload / unique_key 用的都是内部 id）。
func (h *harness) topicID(t *testing.T, publicID string) int64 {
	t.Helper()
	var id int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM topics WHERE public_id = $1", publicID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
