package forum

import (
	"testing"
	"time"

	"forum/internal/authz"
)

// 「已经手动通过的帖子编辑，帖子页面不更新」——审核员那一侧的复现与钉桩。
//
// 与 TestEditingKeepsTheApprovedPostLive 的差别（那一条是**作者自批**、且时间不前进）：
//  1. 批准的人是**另一个人的审核员**（用户报的就是这条）；
//  2. 编辑与批准之间**时钟前进**，并把队列项的 updated_at 原样回传给 ReviewTopic
//     —— 这正是 HTTP 层的必填参数 expected_updated_at（handler 侧强制）。
//
// 这条与 HTTP 的差别只有一个：这里直接调 Service（handler 只是解包 + 必填校验）。
func TestModeratorApprovalPromotesEditToTopicDetail(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	mod, _ := h.author("mod", 5, true, authz.PermPostReview)
	reader, _ := h.author("bob", 5, true, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)

	// 作者没有 post.review → 首发是 pending；审核员放行 V1，它成为线上版本。
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1"})
	if _, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}

	// 作者改稿 → 进待审槽，线上仍是 V1。
	h.clk.T = h.clk.T.Add(time.Minute)
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V2")}); err != nil {
		t.Fatal(err)
	}

	// 审核员读队列：拿到他看到的那个版本号（HTTP 层必填的就是它）。
	queue, err := h.svc.ListReviewQueue(h.ctx, mod, ReviewQueueInput{State: ReviewQueueDraft})
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Items) != 1 || queue.Items[0].ID != d.ID {
		t.Fatalf("已发布 + 有改动应出现在 draft 档，实际 %d 条", len(queue.Items))
	}
	seen := queue.Items[0]

	// 审核员点「放行」，原样回传他看队列时的版本号。
	h.clk.T = h.clk.T.Add(time.Minute)
	if _, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewApprove, "", seen.UpdatedAt); err != nil {
		t.Fatalf("审核员放行失败: %v", err)
	}

	// ① 读者打开的帖子页（TopicDetail）必须是新版正文。
	after, err := h.svc.TopicDetail(h.ctx, reader, d.ID)
	if err != nil {
		t.Fatalf("放行后读者应看得到帖子: %v", err)
	}
	if after.ContentMD != "V2" {
		t.Fatalf("放行后读者应看到新版正文 V2，实际 %q", after.ContentMD)
	}
	if after.ContentHTML != "<p>V2</p>" {
		t.Fatalf("content_html 必须是新版渲染，实际 %q", after.ContentHTML)
	}
	if after.PendingDraft {
		t.Fatal("放行后读者不应带着待审草稿标记")
	}
	if after.RevisionOf != nil {
		t.Fatalf("放行后没有待审改动，revision_of 应为空，实际 %+v", after.RevisionOf)
	}

	// ② 线上正文那一份。
	if got := h.postMD(t, d.ID); got != "V2" {
		t.Fatalf("posts.content_md 应为 V2，实际 %q", got)
	}
	// ③ 摘要与正文同源。
	var excerpt string
	if err := h.pool.QueryRow(h.ctx, "SELECT excerpt FROM topics WHERE public_id = $1", d.ID).Scan(&excerpt); err != nil {
		t.Fatal(err)
	}
	if excerpt != "V2" {
		t.Fatalf("摘要应换成 V2，实际 %q", excerpt)
	}
	// ④ 待审槽清空。
	if got := h.pendingMD(t, d.ID); got != "" {
		t.Fatalf("放行后待审槽必须清空，实际 %q", got)
	}
	// ⑤ 快照与线上正文逐字相同。
	if got := h.revisionMD(t, d.ID); got != "V2" {
		t.Fatalf("快照 content_md 应为 V2，实际 %q", got)
	}

	// ⑥ 审核员**自己**重开帖子页：拿到的也必须是已替换的新版，而不是他刚批过的那份草稿。
	//（判据是归属 / canSeePending —— 审核员走的是「看到待审草稿」那一支，放行后待审槽已清，
	// 这一支自然让位给线上正文。漏了这一条，审核员会以为「我批了但页面上还是那份草稿」。）
	modView, err := h.svc.TopicDetail(h.ctx, mod, d.ID)
	if err != nil {
		t.Fatalf("审核员应看得到这条帖子: %v", err)
	}
	if modView.ContentMD != "V2" || modView.ContentHTML != "<p>V2</p>" {
		t.Fatalf("审核员重开页面应看到新版 V2，实际 %q / %q", modView.ContentMD, modView.ContentHTML)
	}
	if modView.PendingDraft || modView.RevisionOf != nil {
		t.Fatalf("放行后审核员不应再带着草稿标记，实际 pending_draft=%v revision_of=%+v",
			modView.PendingDraft, modView.RevisionOf)
	}

	// ⑦ 作者那一侧同理：他手上那份草稿已经成为线上版本，不再标着「待审」。
	authorView, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if authorView.ContentMD != "V2" || authorView.PendingDraft {
		t.Fatalf("放行后作者看到的就是线上那一版，实际 %q/%v", authorView.ContentMD, authorView.PendingDraft)
	}
}
