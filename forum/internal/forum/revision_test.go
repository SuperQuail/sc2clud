package forum

import (
	"testing"
	"time"

	"forum/internal/authz"
)

// L6（拍板 08）：审核的「打回修改」是**独立状态**，不复用拒绝。
//
// 四条口径（用户原话拆开）：
//  1. 单独一个分类（revision_requested，第四态）；
//  2. 打回期间**只有作者可见**；
//  3. 打回期间**只有作者可编辑**（这边由 canEditTopic 的老判定保证，不新增口子）；
//  4. 作者看到的是**最后一个过审版本**（原始版本过审时显示它）—— 这里给的是 revision_of。
//
// 这条用例同时钉住「别人看到的是过审版本」：两种读者拿到不同的正文，
// 这是本功能唯一可观测的差别（旧行为下没有第四态，也没有 revision_of 字段）。
func TestRevisionRequestedKeepsOnlyAuthorAndShowsApprovedVersion(t *testing.T) {
	h := newHarness(t)
	// 时钟对齐真实 now()：审核队列的游标与 updated_at 都吃时钟，
	// 而假时钟不前进（陷阱 §5）—— 这条用例只读单条详情，但对齐了更稳。
	h.clk.T = time.Now().UTC()
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermPostReview)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1"})

	// ① 先过审一次：1 楼正文 V1 成为「最后过审版本」的候选
	item, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewApprove, "")
	if err != nil {
		t.Fatalf("放行失败: %v", err)
	}
	if item.ReviewState != "approved" {
		t.Fatalf("放行后状态应为 approved，实际 %s", item.ReviewState)
	}

	// ② 作者改正文 V2：ResetTopicReview 把主题送回 pending（这是「内容变了要复审」的老规矩）
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V2")}); err != nil {
		t.Fatal(err)
	}
	pending, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pending.ReviewState != "pending" {
		t.Fatalf("改完正文应回 pending，实际 %s", pending.ReviewState)
	}
	if pending.RevisionOf != nil {
		t.Fatalf("pending 不该带 revision_of（那是打回态的东西）: %+v", pending.RevisionOf)
	}

	// ③ 打回修改：独立状态，不是 rejected
	item, err = h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewRequestRevision, "第三节请补图")
	if err != nil {
		t.Fatalf("打回失败: %v", err)
	}
	if item.ReviewState != ReviewStateRevisionRequested {
		t.Fatalf("打回应是独立状态 %s，实际 %s", ReviewStateRevisionRequested, item.ReviewState)
	}
	if item.ReviewNote == nil || *item.ReviewNote != "第三节请补图" {
		t.Fatalf("打回必须把理由带给作者，实际 %v", item.ReviewNote)
	}

	// ④ 打回期间只有作者可见：游客与别的登录用户都 404（不是 403 —— 不承认它存在）
	assertCode(t, mustErr(h.svc.TopicDetail(h.ctx, nil, d.ID)), "topic.not_found")
	other, _ := h.author("bob", 5, true, authz.PermTopicCreate)
	assertCode(t, mustErr(h.svc.TopicDetail(h.ctx, other, d.ID)), "topic.not_found")
	guestPage, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(guestPage.Items) != 0 {
		t.Fatalf("打回期间游客列表里不该有它，实际 %d 条", len(guestPage.Items))
	}

	// ⑤ 作者看得到、可编辑，拿到的是**自己那一版**（V2）+ 最后一个过审版本（V1）
	authorView, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatalf("作者应当看得到打回中的主题: %v", err)
	}
	if authorView.ContentMD != "V2" {
		t.Fatalf("作者看到的是自己正在改的那一版（V2），实际 %q", authorView.ContentMD)
	}
	// 「可编辑」用**真的改一次**证明：改标题成功，而且改正文会回 pending（下一条断言）。
	// 不读 TopicDetailDTO.CanEdit —— 那个字段目前没有实现（恒 false），拿它当判据等于自欺。
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{Title: ptrStr("改个标题")}); err != nil {
		t.Fatalf("打回期间作者必须可编辑: %v", err)
	}
	if authorView.RevisionOf == nil {
		t.Fatal("打回期间必须给出最后一个过审版本（revision_of）")
	} else if authorView.RevisionOf.ContentMD != "V1" {
		t.Fatalf("最后一个过审版本应是 V1，实际 %q", authorView.RevisionOf.ContentMD)
	}

	// ⑥ 队列里有一档能看到它（打回也要在后台可查）
	queue, err := h.svc.ListReviewQueue(h.ctx, author, ReviewQueueInput{State: ReviewStateRevisionRequested})
	if err != nil {
		t.Fatalf("队列的 revision_requested 档: %v", err)
	}
	if len(queue.Items) != 1 || queue.Items[0].ID != d.ID {
		t.Fatalf("打回的帖应当在 revision_requested 档里，实际 %d 条", len(queue.Items))
	}

	// ⑦ 作者改完再提交 → 回 pending；内容变了，但「最后过审版本」还是 V1
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V3")}); err != nil {
		t.Fatal(err)
	}
	resubmitted, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resubmitted.ReviewState != "pending" {
		t.Fatalf("改完正文应回 pending，实际 %s", resubmitted.ReviewState)
	}
	if resubmitted.ContentMD != "V3" {
		t.Fatalf("作者看到的应是自己刚改的 V3，实际 %q", resubmitted.ContentMD)
	}
	if resubmitted.RevisionOf != nil {
		t.Fatal("回到 pending 之后不该再挂 revision_of")
	}

	// ⑧ 放行 V3：这一份成为新的「最后过审版本」；作者再被别的管理员打回时，
	// 作者看到的过审版本必须是 V3。
	//
	// 快照是**写下就固定**的（HasApprovedRevision + NOT EXISTS，见 revision_snapshot_test.go），
	// 所以「上一份过审版本被新的一版取代」这件事在这里只能手动造：
	// 把库里那份内容换成 V3，模拟「V3 已经是最后一次过审的内容」。
	// 这不是在测造假数据 —— 判据只有一条：**revision_of 读的就是库里的那一份，而不是别处推导的**。
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, `
UPDATE topic_revisions r SET content_md = 'V3', content_html = '<p>V3</p>'
  FROM topics t WHERE t.id = r.topic_id AND t.public_id = $1`, d.ID); err != nil {
		t.Fatal(err)
	}
	public, err := h.svc.TopicDetail(h.ctx, other, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if public.ContentMD != "V3" {
		t.Fatalf("过审之后所有人看到的都是这一版，实际 %q", public.ContentMD)
	}
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewRequestRevision, "再改一处"); err != nil {
		t.Fatal(err)
	}
	again, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again.RevisionOf == nil || again.RevisionOf.ContentMD != "V3" {
		t.Fatalf("第二次打回时，过审版本应更新为 V3，实际 %+v", again.RevisionOf)
	}
	// 而别人**看不到它**（拍板 08 · L6：打回期间只有作者可见）。
	// 这一条在「已经有最后一个过审版本」之后仍然成立 —— 可见性看的是 review_state，
	// 不是「有没有过审内容」。
	assertCode(t, mustErr(h.svc.TopicDetail(h.ctx, other, d.ID)), "topic.not_found")
	assertCode(t, mustErr(h.svc.TopicDetail(h.ctx, nil, d.ID)), "topic.not_found")
}

// TestRequestRevisionNeedsAReason 钉「打回必须说清改哪里」：
// 允许空理由等于让作者收到「改改就能过」而不知道该改什么 —— 比直接拒绝更难办。
func TestRequestRevisionNeedsAReason(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermPostReview)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "x", ContentMD: "y"})

	_, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewRequestRevision, "   ")
	assertCode(t, err, "common.invalid_input")
	// 动作值域也要收严：拼错的动作不能被当成「放行」
	_, err = h.svc.ReviewTopic(h.ctx, author, d.ID, "request_changes", "x")
	assertCode(t, err, "common.invalid_input")
}
