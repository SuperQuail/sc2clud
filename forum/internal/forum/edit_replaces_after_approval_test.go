package forum

import (
	"testing"

	"forum/internal/authz"
)

// 拍板 08 第二轮 · 6.2「编辑不动原帖、通过再替换」：三个版本 + 谁在什么时候看到哪一版。
//
//	线上版本   posts（floor=1）—— 读者看到的唯一来源，只在**放行**那一刻换
//	待审版本   topic_revisions.pending_md —— 作者改完还没过审的那一份
//	过审版本   topic_revisions.content_md —— 线上那一份的快照，作者的参照物
//
// 旧行为下这条用例必红，而且红在最关键的那一句上：作者一保存，游客/别人读到的
// 就是**未过审的新正文**（UpdateTopic 直接写 posts），读者与作者看到的是同一份。
func TestEditingKeepsTheApprovedPostLive(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermPostReview)
	reader, _ := h.author("bob", 5, true, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1"})

	// 前提：持 post.review 的作者发的帖直接 approved，且首次批准**不写快照**
	//（它此前没有过审内容，见 revision_snapshot_test.go）。
	if d.ReviewState != "approved" {
		t.Fatalf("前提不成立：应当直接过审，实际 %s", d.ReviewState)
	}
	if n := h.countRevisions(t, d.ID); n != 0 {
		t.Fatalf("从没过审的帖不该有待审槽，实际 %d 行", n)
	}

	// ① 作者改正文：线上那一份**一个字不动**，改动只进待审槽。
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V2")}); err != nil {
		t.Fatal(err)
	}
	if got := h.postMD(t, d.ID); got != "V1" {
		t.Fatalf("编辑不动原帖：posts 里应还是 V1，实际 %q", got)
	}
	if got := h.pendingMD(t, d.ID); got != "V2" {
		t.Fatalf("作者那一版应进待审槽，实际 %q", got)
	}

	// ② 读者（登录的别人）看到的仍是过审版；游客同理（列表谓词只放 approved）。
	public, err := h.svc.TopicDetail(h.ctx, reader, d.ID)
	if err != nil {
		t.Fatalf("过审过的帖对别人应当可见（它在待审的是改动，不是帖子本身）: %v", err)
	}
	if public.ContentMD != "V1" {
		t.Fatalf("读者只看得到过审版（V1），实际 %q —— 未过审的改动漏出去了", public.ContentMD)
	}
	if public.PendingDraft {
		t.Fatal("pending_draft 只对作者为真；读者没有待审槽")
	}
	guestList, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(guestList.Items) != 1 {
		t.Fatalf("改动待审期间帖子不该从公开列表消失，实际 %d 条", len(guestList.Items))
	}

	// ③ 作者看得到自己的待审改动（content_md = V2），并且拿到线上那一版当参照。
	mine, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if mine.ContentMD != "V2" || !mine.PendingDraft {
		t.Fatalf("作者应看到自己那一版（V2）且 pending_draft=true，实际 %q/%v", mine.ContentMD, mine.PendingDraft)
	}
	if mine.RevisionOf == nil || mine.RevisionOf.ContentMD != "V1" {
		t.Fatalf("作者应拿到线上那一版（V1）当参照，实际 %+v", mine.RevisionOf)
	}

	// ④ 通过 = 替换：待审版本成为新的线上版本，待审槽清空。
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	if got := h.postMD(t, d.ID); got != "V2" {
		t.Fatalf("审核通过后才替换线上正文，实际 %q", got)
	}
	if n := h.countRevisions(t, d.ID); n != 1 {
		t.Fatalf("替换后应只剩快照那一行，实际 %d 行", n)
	}
	if got := h.pendingMD(t, d.ID); got != "" {
		t.Fatalf("替换之后待审槽必须清空（留着会让下一次编辑读出上一份草稿），实际 %q", got)
	}
	if got := h.revisionMD(t, d.ID); got != "V2" {
		t.Fatalf("快照要与线上正文逐字相同，实际 %q", got)
	}
	var excerpt string
	if err := h.pool.QueryRow(h.ctx, "SELECT excerpt FROM topics WHERE public_id = $1", d.ID).Scan(&excerpt); err != nil {
		t.Fatal(err)
	}
	if excerpt != "V2" {
		t.Fatalf("摘要与正文同源：替换正文时摘要要一起换，实际 %q", excerpt)
	}
	after, err := h.svc.TopicDetail(h.ctx, reader, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ContentMD != "V2" || after.PendingDraft {
		t.Fatalf("替换之后读者看到的就是 V2，实际 %q/%v", after.ContentMD, after.PendingDraft)
	}

	// ⑤ 打回修改：改动仍然只有作者看得到，而**线上还是最后过审那一版**（V2）。
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V3")}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewRequestRevision, "第三节补图"); err != nil {
		t.Fatal(err)
	}
	if got := h.postMD(t, d.ID); got != "V2" {
		t.Fatalf("打回期间线上仍是最后过审版本 V2，实际 %q", got)
	}
	if got := h.pendingMD(t, d.ID); got != "V3" {
		t.Fatalf("打回不丢作者的改动，实际 %q", got)
	}
	// 打回态**只有作者可见**（拍板 08 · L6）——别人拿 404，拿到的不是「旧正文」而是「没有这条」。
	assertCode(t, mustErr(h.svc.TopicDetail(h.ctx, reader, d.ID)), "topic.not_found")
	draftView, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if draftView.ContentMD != "V3" || draftView.RevisionOf == nil || draftView.RevisionOf.ContentMD != "V2" {
		t.Fatalf("打回期间作者看到 V3、参照 V2，实际 %q / %+v", draftView.ContentMD, draftView.RevisionOf)
	}
	if draftView.ReviewState != ReviewStateRevisionRequested {
		t.Fatalf("打回是独立状态，实际 %s", draftView.ReviewState)
	}

	// ⑥ 再放行：V3 上台。
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	if got := h.postMD(t, d.ID); got != "V3" {
		t.Fatalf("第二次放行后线上应是 V3，实际 %q", got)
	}
}

// TestRejectingADraftKeepsTheApprovedPostLive 钉「打回/拒绝之后保留最后过审版」：
// 被拒绝的是**改动**，不是帖子 —— 线上那一份不该被清掉，也不该被新草稿顶替。
func TestRejectingADraftKeepsTheApprovedPostLive(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermPostReview)
	reader, _ := h.author("bob", 5, true, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1"})

	// 让 V1 成为真正的「线上版本」：批准一次（首次批准不写快照的那条规矩由此让路 ——
	// 这次批准时上一态已是 approved，快照按老规矩记下 V1，正是读者此刻在看的那一份）。
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.TopicDetail(h.ctx, reader, d.ID); err != nil {
		t.Fatalf("过审的帖对读者应当可见: %v", err)
	}

	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V2")}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewReject, "与分区主题不符"); err != nil {
		t.Fatal(err)
	}

	// 被拒的是改动：线上还是 V1，而草稿**留在待审槽里**（作者改一改就能再提）。
	if got := h.postMD(t, d.ID); got != "V1" {
		t.Fatalf("拒绝一个改动不该动线上正文，实际 %q", got)
	}
	if got := h.pendingMD(t, d.ID); got != "V2" {
		t.Fatalf("作者的改动不该被拒绝动作丢掉，实际 %q", got)
	}
	// rejected 的可见性回到「只有作者」= 帖子从公开流消失（它在等作者改，不是发布态）。
	assertCode(t, mustErr(h.svc.TopicDetail(h.ctx, reader, d.ID)), "topic.not_found")
	mine, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if mine.ContentMD != "V2" || mine.RevisionOf == nil || mine.RevisionOf.ContentMD != "V1" {
		t.Fatalf("作者应看到草稿 V2 + 参照 V1，实际 %q / %+v", mine.ContentMD, mine.RevisionOf)
	}
}

// TestDraftQueueScopeShowsEditsAwaitingReplacement 钉 06.2 的**闭环**：
// 「通过再替换」要有人能批 —— 一条已发布帖的改动必须出现在队列里。
//
// 为什么它不是 pending 档：pending 的含义是「这条帖子还没发布」，而 06.2 之后
// 已发布帖的改动**不动 review_state**（读者要能继续看到线上那一版），
// 所以它单开一档 'draft'。少了这一档，发布过的帖子改完就永远上不了台。
func TestDraftQueueScopeShowsEditsAwaitingReplacement(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermPostReview)
	mod, _ := h.author("mod", 5, true, authz.PermPostReview)
	h.seedBoard("general", 0, false)

	// ① 从没过审的待审帖：在 pending 档，不在 draft 档（它没有线上版本可替换）。
	fresh := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "新帖", ContentMD: "V1"})
	// mustTopic 走的是持 post.review 的作者 → 直接 approved；这里改一下状态造一条真待审的。
	if _, err := h.pool.Exec(h.ctx, "UPDATE topics SET review_state = 'pending' WHERE public_id = $1", fresh.ID); err != nil {
		t.Fatal(err)
	}

	// ② 已发布的帖 + 待替换的改动。
	live := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "已发布", ContentMD: "V1"})
	if err := h.svc.UpdateTopic(h.ctx, author, live.ID, UpdateTopicInput{ContentMD: ptrStr("V2")}); err != nil {
		t.Fatal(err)
	}

	drafts, err := h.svc.ListReviewQueue(h.ctx, mod, ReviewQueueInput{State: ReviewQueueDraft})
	if err != nil {
		t.Fatal(err)
	}
	if len(drafts.Items) != 1 || drafts.Items[0].ID != live.ID {
		t.Fatalf("draft 档应只有「已发布 + 有改动」的那一条，实际 %d 条", len(drafts.Items))
	}
	if drafts.Items[0].ReviewState != "approved" {
		t.Fatalf("待替换的改动仍然挂在 approved 上（读者要能看线上那一版），实际 %s", drafts.Items[0].ReviewState)
	}
	// 没有改动的帖不会出现在这一档里（两个方向都要成立，否则这档会变成「全部已发布」）。
	if _, err := h.svc.ReviewTopic(h.ctx, mod, live.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	drafts, err = h.svc.ListReviewQueue(h.ctx, mod, ReviewQueueInput{State: ReviewQueueDraft})
	if err != nil {
		t.Fatal(err)
	}
	if len(drafts.Items) != 0 {
		t.Fatalf("替换之后 draft 档应当空，实际 %d 条", len(drafts.Items))
	}

	// pending 档里只有那条真待审的新帖 —— 两个档位不重叠。
	pend, err := h.svc.ListReviewQueue(h.ctx, mod, ReviewQueueInput{State: ReviewQueuePending})
	if err != nil {
		t.Fatal(err)
	}
	if len(pend.Items) != 1 || pend.Items[0].ID != fresh.ID {
		t.Fatalf("pending 档应只有待审的新帖，实际 %d 条", len(pend.Items))
	}

	// 档位白名单也跟着收：拼错的档位仍然是 400（值域只有这一处）。
	if _, err := h.svc.ListReviewQueue(h.ctx, mod, ReviewQueueInput{State: "drafts"}); err == nil {
		t.Fatal("未知档位应当 400")
	}
}

// postMD 读线上正文（posts 的 1 楼）——「读者看到哪一版」的物理落点。
func (h *harness) postMD(t *testing.T, topicPublicID string) string {
	t.Helper()
	var md string
	if err := h.pool.QueryRow(h.ctx, `
SELECT COALESCE(p.content_md, '') FROM posts p
  JOIN topics t ON t.id = p.topic_id WHERE t.public_id = $1 AND p.floor = 1`,
		topicPublicID).Scan(&md); err != nil {
		t.Fatal(err)
	}
	return md
}

// pendingMD 读待审槽（没有行 / 没有草稿都返回空串）。
func (h *harness) pendingMD(t *testing.T, topicPublicID string) string {
	t.Helper()
	var md string
	if err := h.pool.QueryRow(h.ctx, `
SELECT COALESCE(r.pending_md, '') FROM topic_revisions r
  JOIN topics t ON t.id = r.topic_id WHERE t.public_id = $1`,
		topicPublicID).Scan(&md); err != nil {
		if err.Error() == "no rows in result set" {
			return ""
		}
		t.Fatal(err)
	}
	return md
}
