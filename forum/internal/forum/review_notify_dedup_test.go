package forum

import (
	"testing"
	"time"

	"forum/internal/authz"
)

// M5（拍板 08）：「确认审核通知的 dedup 取舍 —— 确认现状修复有效（写一条验证）」。
//
// 现状（C12 的取舍，2026-10-14）：**带快照的审核通知不写 dedup_key** ——
// 审核结果是**事件**，不是状态。代价写在账上：同一结论连判两次，作者会收到两条相同通知。
//
// 这条用例在**入队这一侧**钉住那个取舍：去重键有两个来源，缺一不可：
//
//	· 任务上的 UniqueKey（队列层去重：相同 key 的未完成任务只留一个）；
//	· 通知行上的 dedup_key（DB 层去重：uq_notifications_user_dedup）。
//
// 少关任何一个，改判的第二条都会被吃掉，而「作者收到几条」这件事**只能**靠这两处解释 ——
// 通知落库那一侧的闭环在 notify 包里（TestNotifyReviewKeepsBothVerdicts），两处各自证明自己那一半。
func TestReviewNotificationCarriesNoDedupAndKeepsBothVerdicts(t *testing.T) {
	h := newHarness(t)
	h.clk.T = time.Now().UTC()
	reviewer, _ := h.author("mod", 5, true, authz.PermTopicCreate, authz.PermPostReview)
	author, _ := h.author("alice", 5, false, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "待审帖", ContentMD: "V1"})
	if d.ReviewState != "pending" {
		t.Fatalf("前提不成立：新帖应当是 pending，实际 %s", d.ReviewState)
	}

	// 先拒（带理由），紧接着放行 —— 这正是 M5 实测出问题的那条序列。
	if _, err := h.svc.ReviewTopic(h.ctx, reviewer, d.ID, ReviewReject, "来源不明"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.ReviewTopic(h.ctx, reviewer, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}

	tasks := h.queue.tasksOf("notify:review")
	if len(tasks) != 2 {
		t.Fatalf("两次判定必须投两条通知任务（改判是两次事实），实际 %d 条", len(tasks))
	}
	// ① 任务不设 UniqueKey：设了的话第二条在队列层就被并成一条。
	for i, task := range tasks {
		if task.UniqueKey != "" {
			t.Fatalf("第 %d 条审核通知任务不该有 UniqueKey（去重会把改判吃掉），实际 %q", i, task.UniqueKey)
		}
	}
	// ② payload 必须带**判定那一刻**的 state/text：延迟消费时现读 topics 会把两条都读成后一个状态。
	first, _ := tasks[0].Payload.(map[string]any)
	second, _ := tasks[1].Payload.(map[string]any)
	if first["state"] != "rejected" || first["text"] != "来源不明" {
		t.Fatalf("第一条任务应带拒绝与理由，实际 %v", first)
	}
	if second["state"] != "approved" {
		t.Fatalf("第二条任务应带放行，实际 %v", second)
	}
	// ③ 「带快照」正是 notify 侧关掉 dedup_key 的判据（notify/service.go: in.Extra["state"] == nil）。
	// 少了 payload 里的 state，notify 会按状态类通知去重，第二条又被吃掉。
	for i, task := range tasks {
		p, _ := task.Payload.(map[string]any)
		if _, ok := p["state"]; !ok {
			t.Fatalf("第 %d 条任务缺 state（notify 靠它判「带快照 → 不写 dedup_key」）: %v", i, p)
		}
		if _, ok := p["text"]; !ok {
			t.Fatalf("第 %d 条任务缺 text: %v", i, p)
		}
	}
}
