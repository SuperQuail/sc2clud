package forum

import (
	"testing"
	"time"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/forum/pgsql"
)

// review_queue_test.go 钉住「审核队列能把 pending 变成 approved」这条闭环。
//
// 这条闭环此前**完全不存在**（2026-10-14 补）：AI 拿不准的主题留在 pending，而公开流只放行
// review_state='approved'，于是帖子在所有列表里消失、没有任何端点能救回来。
// 所以第一个断言就是「发完帖公开流看不到它」——它是这个缺陷的直接表达。

func TestReviewQueueApproveFlow(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	h.seedBoard("campaign", 0, false)
	authorID := h.seedUser("author", roleID, 1, false) // trusted=false：不享审核豁免
	author := h.actor(authorID, roleID, authz.PermTopicCreate)

	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "campaign", Title: "待审帖", ContentMD: "正文"})
	if d.ReviewState != "pending" {
		t.Fatalf("普通作者发的主题应当留在 pending，实际 %q", d.ReviewState)
	}

	// ① 公开流看不到它 —— 这就是「AI 拿不准 = 帖子消失」的直接表达
	feed, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(feed.Items) != 0 {
		t.Fatalf("待审主题不该出现在公开流，实际 %d 条", len(feed.Items))
	}

	// ② 审核员在队列里能看到它，并且带得出「AI 说了什么」
	modID := h.seedUser("mod", roleID, 1, true)
	mod := h.actor(modID, roleID, authz.PermPostReview)
	queue, err := h.svc.ListReviewQueue(h.ctx, mod, ReviewQueueInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Items) != 1 || queue.Items[0].ID != d.ID {
		t.Fatalf("队列应当有且只有这一条，实际 %+v", queue.Items)
	}
	if queue.Items[0].ReviewState != "pending" || queue.Items[0].Author.Handle != "author" {
		t.Fatalf("队列项的形状不对: %+v", queue.Items[0])
	}

	// ③ 放行：三件事必须都发生 —— 状态、审计、给作者的通知任务
	h.queue.reset()
	item, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewApprove, "")
	if err != nil {
		t.Fatalf("放行失败: %v", err)
	}
	if item.ReviewState != "approved" {
		t.Fatalf("放行后 review_state 应当是 approved，实际 %q", item.ReviewState)
	}
	// review_source=manual 是**不可省**的一列：AI 任务见到 manual 会直接返回（d7 §1 铁律）
	if item.ReviewSource == nil || *item.ReviewSource != "manual" {
		t.Fatalf("人工判定必须落 review_source=manual，实际 %v", item.ReviewSource)
	}
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = $1", AuditReviewAction); n != 1 {
		t.Fatalf("审计应当有 1 行，实际 %d", n)
	}
	found := false
	for _, ty := range h.queue.types() {
		if ty == "notify:review" {
			found = true
		}
	}
	if !found {
		t.Fatalf("放行后应当投一条 notify:review，实际任务: %v", h.queue.types())
	}

	// ④ 放行之后作者能改，改完必须**回到待审**（复审由「内容变了」触发）
	item2, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewReject, "来源不明")
	if err != nil {
		t.Fatal(err)
	}
	if item2.ReviewState != "rejected" || item2.ReviewNote == nil || *item2.ReviewNote != "来源不明" {
		t.Fatalf("拒绝必须落状态与理由，实际 %+v", item2)
	}

	// ⑤ 通过之后公开流才看得到
	if _, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	feed2, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(feed2.Items) != 1 {
		t.Fatalf("放行后公开流应当有 1 条，实际 %d 条", len(feed2.Items))
	}
}

// 拒绝必须给理由：作者在帖子页看到的就是这条 review_note，空理由等于让人收到「未通过」而不知道为什么。
func TestReviewQueueRejectNeedsNote(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	h.seedBoard("campaign", 0, false)
	authorID := h.seedUser("author", roleID, 1, false)
	d := h.mustTopic(h.actor(authorID, roleID, authz.PermTopicCreate),
		CreateTopicInput{BoardSlug: "campaign", Title: "t", ContentMD: "x"})

	modID := h.seedUser("mod", roleID, 1, true)
	mod := h.actor(modID, roleID, authz.PermPostReview)

	if _, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewReject, "   "); err == nil {
		t.Fatal("空理由的拒绝必须被拒绝")
	}
	// 状态不能被这次失败改掉
	var state string
	if err := h.pool.QueryRow(h.ctx, "SELECT review_state FROM topics WHERE public_id = $1", d.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "pending" {
		t.Fatalf("失败的判定不该改状态，实际 %q", state)
	}
}

// 队列是权限点守着的：游客 401、无 post.review 403、参数非法 400。
func TestReviewQueueGuards(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	h.seedBoard("campaign", 0, false)
	plainID := h.seedUser("plain", roleID, 1, false)
	plain := h.actor(plainID, roleID)

	if _, err := h.svc.ListReviewQueue(h.ctx, nil, ReviewQueueInput{}); err == nil {
		t.Fatal("游客必须 401")
	}
	_, err := h.svc.ListReviewQueue(h.ctx, plain, ReviewQueueInput{})
	if err == nil {
		t.Fatal("没有 post.review 必须 403")
	}
	assertCode(t, err, "common.forbidden")
	if _, err := h.svc.ListReviewQueue(h.ctx, plain, ReviewQueueInput{State: "approved"}); err == nil {
		t.Fatal("state=approved 必须 400（它不是队列的一档）")
	}
	if _, err := h.svc.ReviewTopic(h.ctx, plain, "whatever", "publish", ""); err == nil {
		t.Fatal("action 只认 approve / reject")
	}
}

// 改正文必须成功，并且把主题送回待审 —— 这条路径此前引用**不存在的列**
// （ai_reviewed / ai_review_note，任何迁移里都没有），PATCH 带 content_md 必然 500。
// H1：AI 复核 reject 会把 visibility 置 hidden，而全仓只有 AI 写 hidden、DeleteTopic 写 deleted ——
// **没有任何路径能改回 normal**。放行时不还原它，「通过」的帖子谁也看不到，前端又只看 review_state
// （连审核横幅都没有），管理员与作者都看不出哪里不对。H2 同一条用例一起钉：放行要投 search:index，
// 否则帖子在搜索里永远不存在。
func TestApproveUnhidesAndReindexes(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	h.seedBoard("campaign", 0, false)
	authorID := h.seedUser("author", roleID, 1, false)
	d := h.mustTopic(h.actor(authorID, roleID, authz.PermTopicCreate),
		CreateTopicInput{BoardSlug: "campaign", Title: "被 AI 藏起来的帖子", ContentMD: "x"})

	// 复刻 AI 复核 reject 的落库（aireview/sql.go 的 sqlUpdateTopic 写的就是这一列）
	if _, err := h.pool.Exec(h.ctx, "UPDATE topics SET visibility = 'hidden' WHERE public_id = $1", d.ID); err != nil {
		t.Fatal(err)
	}

	mod := h.actor(h.seedUser("mod", roleID, 1, true), roleID, authz.PermPostReview)
	h.queue.reset()
	item, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewApprove, "")
	if err != nil {
		t.Fatalf("放行失败: %v", err)
	}
	if item.ReviewState != "approved" {
		t.Fatalf("review_state 应当是 approved，实际 %q", item.ReviewState)
	}

	var visibility string
	if err := h.pool.QueryRow(h.ctx, "SELECT visibility FROM topics WHERE public_id = $1", d.ID).Scan(&visibility); err != nil {
		t.Fatal(err)
	}
	if visibility != "normal" {
		t.Fatalf("放行必须把 hidden 还原成 normal，实际 %q（这就是「通过了但谁也看不到」）", visibility)
	}

	feed, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(feed.Items) != 1 {
		t.Fatalf("放行后公开流应当有 1 条，实际 %d 条", len(feed.Items))
	}

	// H2：搜索索引靠 search:index 重建（indexTopic 对未过审主题是把索引行删掉）
	found := false
	for _, ty := range h.queue.types() {
		if ty == "search:index" {
			found = true
		}
	}
	if !found {
		t.Fatalf("放行必须投 search:index，实际任务: %v", h.queue.types())
	}
}

// H3：判定只能落在「读到的那一版」上。这里直接钉 SQL 守卫 —— 期望状态与实际不符时必须是 0 行，
// 而不是把新内容（作者刚改过的正文）写成 approved。
func TestSetTopicReviewRejectsStaleState(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	h.seedBoard("campaign", 0, false)
	authorID := h.seedUser("author", roleID, 1, false)
	d := h.mustTopic(h.actor(authorID, roleID, authz.PermTopicCreate),
		CreateTopicInput{BoardSlug: "campaign", Title: "t", ContentMD: "x"})

	var id int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM topics WHERE public_id = $1", d.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	err := h.dbTx(func(tx *ent.Tx) error {
		// 版本传 nil = 只校验状态（本条钉的是状态守卫；版本守卫见 TestReviewConflictOnEditedVersion）
		n, err := pgsql.SetTopicReview(h.ctx, tx, id, "approved", nil, authorID, true, "rejected", nil, h.clk.Now())
		if err != nil {
			return err
		}
		if n != 0 {
			t.Fatalf("期望状态不符时必须改 0 行，实际 %d 行", n)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var state string
	if err := h.pool.QueryRow(h.ctx, "SELECT review_state FROM topics WHERE id = $1", id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "pending" {
		t.Fatalf("过期判定不该改状态，实际 %q", state)
	}
}

// D1（盲测 X4）：作者在审核员看队列之后改了正文时，**状态是 pending → pending，一个字没变**，
// 只比 review_state 的守卫抓不到。判定必须带上「我看到的那一版」（expected_updated_at）。
func TestReviewConflictOnEditedVersion(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	h.seedBoard("campaign", 0, false)
	authorID := h.seedUser("author", roleID, 1, false)
	author := h.actor(authorID, roleID, authz.PermTopicCreate, authz.PermTopicEditOwn)
	mod := h.actor(h.seedUser("mod", roleID, 1, true), roleID, authz.PermPostReview)

	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "campaign", Title: "t", ContentMD: "第一版"})
	// 审核员在队列里看到的那一版
	queue, err := h.svc.ListReviewQueue(h.ctx, mod, ReviewQueueInput{})
	if err != nil {
		t.Fatal(err)
	}
	seen := queue.Items[0].UpdatedAt

	// 作者改了正文（回 pending、内容换了）。
	// 必须先把假时钟往前推：updated_at 就是版本号，冻结的时钟会让两次写入拿到同一个时间戳，
	// 那样这条用例测的就不是守卫而是时钟（生产用真时钟，微秒精度）。
	h.clk.T = h.clk.T.Add(2 * time.Minute)
	body := "第三版正文"
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: &body}); err != nil {
		t.Fatal(err)
	}

	// 拿旧版本号去批准：必须被拒（否则放出的是一份没人看过的内容）
	if _, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewApprove, "", seen); err == nil {
		t.Fatal("内容在判定前变过时必须冲突，不能被批准")
	}
	var state string
	if err := h.pool.QueryRow(h.ctx, "SELECT review_state FROM topics WHERE public_id = $1", d.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "pending" {
		t.Fatalf("被拒的判定不该改状态，实际 %q", state)
	}
}

func TestEditBodyResetsReview(t *testing.T) {
	h := newHarness(t)
	roleID := h.seedRole("user", false)
	h.seedBoard("campaign", 0, false)
	authorID := h.seedUser("author", roleID, 1, false)
	author := h.actor(authorID, roleID, authz.PermTopicCreate, authz.PermTopicEditOwn)

	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "campaign", Title: "t", ContentMD: "第一版"})

	// 先由审核员放行，再改正文：改完必须回到 pending（复审由「内容变了」触发）
	mod := h.actor(h.seedUser("mod", roleID, 1, true), roleID, authz.PermPostReview)
	if _, err := h.svc.ReviewTopic(h.ctx, mod, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}

	body := "第二版正文"
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: &body}); err != nil {
		t.Fatalf("改正文必须成功（此前这里因为引用不存在的列而必然 500）: %v", err)
	}
	var resetState string
	if err := h.pool.QueryRow(h.ctx, "SELECT review_state FROM topics WHERE public_id = $1", d.ID).Scan(&resetState); err != nil {
		t.Fatal(err)
	}
	if resetState != "pending" {
		t.Fatalf("改过正文应当回到 pending，实际 %q", resetState)
	}

	// 四列一起清：不能留着上一版的判定来源与理由，否则会被读成对新内容的结论
	var source, note, by string
	var at *string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT COALESCE(review_source,''), COALESCE(review_note,''), COALESCE(reviewed_by::text,''), reviewed_at::text FROM topics WHERE public_id = $1",
		d.ID).Scan(&source, &note, &by, &at); err != nil {
		t.Fatal(err)
	}
	if source != "" || note != "" || by != "" || at != nil {
		t.Fatalf("回到待审时必须清掉上一版判定：source=%q note=%q by=%q at=%v", source, note, by, at)
	}
}
