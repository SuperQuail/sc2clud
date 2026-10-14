package forum

import (
	"encoding/json"
	"testing"

	"forum/internal/authz"
)

// 「已转人工」那一档（拍板 08 §第三轮 6）：pending 一个值下面其实是两件事 ——
// 「AI 正在自动检查，几十秒」与「已经在人工队列里，等一个人」。作者唯一能看到的线索就是这一句。
//
// 判据是 **review_events 最新一条判定的 verdict**（d7 §1 的状态机：AI 拿不准 → verdict=review → 人工队列）：
//
//	· 最新一条是 review  → 已转人工（pendingHuman = true）；
//	· 最新一条是 approve（人工已经判过）→ 不再是「已转人工」，
//	  所以判据**不能**写成「存在过 verdict=review」—— 那种写法在判完之后永远为真。
func TestTopicDetailReportsPendingHumanFromLatestReviewEvent(t *testing.T) {
	h := newHarness(t)
	h.seedBoard("general", 0, false)
	author, uid := h.author("alice", 1, false, authz.PermTopicCreate)
	d := h.mustTopic(author, CreateTopicInput{
		BoardSlug: "general", Kind: "discussion", Title: "等待人工的帖子", ContentMD: "正文",
	})
	if d.ReviewState != "pending" {
		t.Fatalf("前置条件不成立：未 trusted 的作者应进待审，实际 %s", d.ReviewState)
	}

	// ① 还没判过：谁都没说「转人工」，这一档必须是 false（不是「默认 true」）
	got, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatalf("读详情失败: %v", err)
	}
	if got.ReviewPendingHuman {
		t.Fatal("还没转人工就报 pendingHuman=true（横幅会说「已转人工」，而队列里其实还没人接）")
	}

	// ② AI 拿不准 → 一条 verdict=review 的判定事件（d7 §1 的第三种结论）
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO review_events (topic_id, trigger, source, verdict, reason, created_at)
		VALUES ((SELECT id FROM topics WHERE public_id = $1), 'create', 'ai', 'review', '拿不准，交人工', now())`, d.ID); err != nil {
		t.Fatal(err)
	}

	got, err = h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatalf("读详情失败: %v", err)
	}
	if !got.ReviewPendingHuman {
		t.Fatal("最新一条判定是 review（AI 转人工），ReviewPendingHuman 应当是 true")
	}
	// 响应里也要有它（前端读的就是 JSON 的字段名）
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["review_pending_human"] != true {
		t.Fatalf("响应里 review_pending_human = %v，想要 true（前端按这个键读）", wire["review_pending_human"])
	}

	// ③ 人工判过之后（最新一条变成 approve）：不能再说「已转人工」——
	// 这正是「存在过 review」与「最新一条是 review」两种写法的分水岭。
	// created_at 显式 +1s：新的那条必须排在后面（排序键是 (created_at DESC, id DESC)）
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO review_events (topic_id, trigger, source, verdict, reason, actor_id, created_at)
		VALUES ((SELECT id FROM topics WHERE public_id = $1), 'manual', 'manual', 'approve', '人工放行', $2, now() + interval '1 second')`, d.ID, uid); err != nil {
		t.Fatal(err)
	}
	got, err = h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatalf("读详情失败: %v", err)
	}
	if got.ReviewPendingHuman {
		t.Fatal("人工已经判过了，仍报 pendingHuman=true（横幅会一直说「已转人工」）")
	}
}
