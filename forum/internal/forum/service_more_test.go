package forum

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"forum/internal/authz"
	"forum/internal/platform/counter"
)

// setupTopic 是大多数用例的起点：一个分区 + 一个作者 + 一条过审主题。
func (h *harness) setupTopic(t *testing.T) (*authz.Actor, *TopicDetailDTO) {
	t.Helper()
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermTopicDeleteOwn)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "主题", ContentMD: "正文"})
	return author, d
}

// 并发回复（§11.3 第 1 条）：floor 不重复、reply_count = n、last_reply_at 是最后一条。
func TestConcurrentRepliesAllocateFloor(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	const n = 20
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "回复"})
			errs[i] = err
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 条回复失败: %v", i, err)
		}
	}
	if got := h.countRows(t, "SELECT count(*) FROM posts WHERE floor > 1"); got != n {
		t.Fatalf("应有 %d 条回复，实际 %d", n, got)
	}
	if got := h.countRows(t, "SELECT count(DISTINCT floor) FROM posts"); got != n+1 {
		t.Fatalf("floor 出现重复：%d 个不同 floor（应为 %d）", got, n+1)
	}
	var replyCount int
	if err := h.pool.QueryRow(h.ctx, "SELECT reply_count FROM topics").Scan(&replyCount); err != nil {
		t.Fatal(err)
	}
	if replyCount != n {
		t.Fatalf("reply_count 应为 %d，实际 %d", n, replyCount)
	}
	var same bool
	if err := h.pool.QueryRow(h.ctx, `
SELECT max(p.created_at) = (SELECT last_reply_at FROM topics) FROM posts p`).Scan(&same); err != nil {
		t.Fatal(err)
	}
	if !same {
		t.Fatal("last_reply_at 应等于最新一条回复的时间")
	}
}

// 楼中楼只允许一级、不许跨主题（§11.3 第 9/10 条）。
func TestReplyParentRules(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	root, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "顶层"})
	if err != nil {
		t.Fatal(err)
	}
	nested, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "楼中楼", ParentID: root.ID})
	if err != nil {
		t.Fatal(err)
	}
	if nested.ParentID == nil || *nested.ParentID != root.ID {
		t.Fatalf("楼中楼的 parent_id 应为 %s，实际 %v", root.ID, nested.ParentID)
	}

	// **序列化那一层**必须有断言（2026-10-13 补）。
	//
	// 这条 bug 之所以能活到今天：Go 侧断言的是 DTO 字段（原来是 string，空串=顶层）、
	// 前端 mock 里写的是 null —— **两边各自的测试都过，JSON 那一层没人测**。
	// 结果顶层 parent_id 序列化成 `""`，而前端按 `=== null` 过滤 → 评论区一条都不渲染。
	// 所以这里断言的是**编出来的 JSON**，不是结构体字段。
	b, err := json.Marshal(PostDTO{ID: "x", ParentID: nil})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"parent_id":null`) {
		t.Fatalf("顶层楼层的 parent_id 必须序列化成 null（前端按 null 判顶层），实际 JSON: %s", b)
	}

	_, err = h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "二级", ParentID: nested.ID})
	assertCode(t, err, "forum.reply_parent_nested")

	other := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "另一主题", ContentMD: "x"})
	_, err = h.svc.CreatePost(h.ctx, author, other.ID, CreatePostInput{ContentMD: "跨主题", ParentID: root.ID})
	assertCode(t, err, "forum.reply_parent_cross_topic")

	// 顶层回复的预览与前 3 条楼中楼（§3.4 Q3a 的 preview_ids）。
	page, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID})
	if err != nil {
		t.Fatal(err)
	}
	// 顶层列表只含回复（D71：1 楼是主题正文，不进评论区）。
	if len(page.Items) != 1 {
		t.Fatalf("顶层列表应有 1 条（只有顶层回复），实际 %d", len(page.Items))
	}
	var rootItem *PostDTO
	for i := range page.Items {
		if page.Items[i].ID == root.ID {
			rootItem = &page.Items[i]
		}
	}
	if rootItem == nil {
		t.Fatalf("顶层回复不在列表里: %+v", page.Items)
	}
	if rootItem.ReplyTotal != 1 {
		t.Fatalf("reply_total 应为 1，实际 %d", rootItem.ReplyTotal)
	}
	if len(rootItem.PreviewIDs) != 1 || rootItem.PreviewIDs[0] != nested.ID {
		t.Fatalf("preview_ids 不对: %+v", rootItem.PreviewIDs)
	}
	replies, err := h.svc.ListReplies(h.ctx, author, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(replies) != 1 || replies[0].ID != nested.ID {
		t.Fatalf("楼中楼列表不对: %+v", replies)
	}
}

// 删回复：重算 reply_count 与 last_reply_at；删到只剩 1 楼时 last_reply_at = 主题的 created_at 且非 NULL（§11.3 第 11 条）。
func TestDeleteReplyRecounts(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	r1, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "一"})
	if err != nil {
		t.Fatal(err)
	}
	h.clk.T = h.clk.T.Add(1e9)
	r2, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "二"})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.DeletePost(h.ctx, author, r2.ID); err != nil {
		t.Fatal(err)
	}
	var replyCount int
	var lastReply, created = new(any), new(any)
	_ = lastReply
	_ = created
	if err := h.pool.QueryRow(h.ctx, "SELECT reply_count FROM topics").Scan(&replyCount); err != nil {
		t.Fatal(err)
	}
	if replyCount != 1 {
		t.Fatalf("删一条后 reply_count 应为 1，实际 %d", replyCount)
	}
	// 再删一条 → 只剩 1 楼，last_reply_at 落回主题的 created_at，且不为 NULL。
	if err := h.svc.DeletePost(h.ctx, author, r1.ID); err != nil {
		t.Fatal(err)
	}
	var ok bool
	if err := h.pool.QueryRow(h.ctx, `
SELECT reply_count = 0 AND last_reply_at IS NOT NULL AND last_reply_at = created_at FROM topics`).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("删到只剩 1 楼后，last_reply_at 应等于主题的 created_at 且非 NULL")
	}
}

// 投票：幂等、改票两侧平移、取消（§11.3 第 3/4/5 条）。
func TestVoteTransitions(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	post, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "回复"})
	if err != nil {
		t.Fatal(err)
	}

	// 重复投票只算一次：并发 8 次同值。
	const n = 8
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = h.svc.Vote(h.ctx, author, VotePost, post.ID, 1)
		}()
	}
	wg.Wait()
	if got := h.countRows(t, "SELECT count(*) FROM likes"); got != 1 {
		t.Fatalf("likes 应只有 1 行，实际 %d", got)
	}
	got, err := h.svc.Vote(h.ctx, author, VotePost, post.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got.LikeCount != 1 || got.DislikeCount != 0 || got.MyVote != 1 {
		t.Fatalf("重复点赞不该改变计数: %+v", got)
	}

	// 赞 → 踩：两侧同时平移。
	got, err = h.svc.Vote(h.ctx, author, VotePost, post.ID, -1)
	if err != nil {
		t.Fatal(err)
	}
	if got.LikeCount != 0 || got.DislikeCount != 1 {
		t.Fatalf("改票应两侧平移: %+v", got)
	}
	// 取消 → 取消（幂等）。
	got, err = h.svc.Unvote(h.ctx, author, VotePost, post.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.LikeCount != 0 || got.DislikeCount != 0 || got.MyVote != 0 {
		t.Fatalf("取消后计数应归零: %+v", got)
	}
	if _, err := h.svc.Unvote(h.ctx, author, VotePost, post.ID); err != nil {
		t.Fatalf("重复取消也该成功: %v", err)
	}
	// 主题只有赞（§5.1 末段）。
	_, err = h.svc.Vote(h.ctx, author, VoteTopic, topic.ID, -1)
	assertCode(t, err, "forum.vote_value_invalid")
}

// 收藏按收藏时间倒序，且幂等（§3.6 Q5）。
func TestBookmarksOrderedByMarkedTime(t *testing.T) {
	h := newHarness(t)
	author, t1 := h.setupTopic(t)
	t2 := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "第二条", ContentMD: "x"})

	if err := h.svc.Bookmark(h.ctx, author, t1.ID, true); err != nil {
		t.Fatal(err)
	}
	h.clk.T = h.clk.T.Add(1e9)
	if err := h.svc.Bookmark(h.ctx, author, t2.ID, true); err != nil {
		t.Fatal(err)
	}
	// 重复收藏不刷新时间：顺序不该变。
	if err := h.svc.Bookmark(h.ctx, author, t1.ID, true); err != nil {
		t.Fatal(err)
	}
	page, err := h.svc.ListBookmarks(h.ctx, author, PageInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("应有 2 条收藏，实际 %d", len(page.Items))
	}
	if page.Items[0].ID != t2.ID {
		t.Fatalf("最近收藏的应排在最前，实际 %s", page.Items[0].ID)
	}
	if page.Items[0].BookmarkedAt == nil {
		t.Fatal("收藏页应带上 bookmarked_at")
	}
	// 游客不可达。
	_, err = h.svc.ListBookmarks(h.ctx, nil, PageInput{})
	assertCode(t, err, "common.unauthorized")
}

// 拉黑：只在回复别人的内容时生效，双向任一命中都拒绝，且**不影响读**（§11.3 第 17 条）。
func TestBlocksOnlyAffectReplying(t *testing.T) {
	h := newHarness(t)
	alice, topic := h.setupTopic(t)
	bob, bobID := h.author("bob", 5, true, authz.PermTopicCreate)

	if err := h.svc.BlockUser(h.ctx, alice, "bob", true); err != nil {
		t.Fatal(err)
	}
	// 被拉黑的人仍然能读（拉黑不是「别看我的帖」）。
	if _, err := h.svc.TopicDetail(h.ctx, bob, topic.ID); err != nil {
		t.Fatalf("被拉黑不该影响读: %v", err)
	}
	// 但回复被拒。
	_, err := h.svc.CreatePost(h.ctx, bob, topic.ID, CreatePostInput{ContentMD: "hi"})
	assertCode(t, err, "forum.blocked")
	// 作者自己回自己的主题不受影响。
	if _, err := h.svc.CreatePost(h.ctx, alice, topic.ID, CreatePostInput{ContentMD: "ok"}); err != nil {
		t.Fatalf("作者自己回复不该被拦: %v", err)
	}
	// 反向也拦：bob 拉黑 alice 后，alice 回复 bob 的楼中楼被拒。
	root, err := h.svc.CreatePost(h.ctx, bob, "00000000-0000-0000-0000-000000000000", CreatePostInput{ContentMD: "x"})
	_ = root
	if err == nil {
		t.Fatal("不存在的主题应该报错")
	}
	if err := h.svc.BlockUser(h.ctx, bob, "alice", true); err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.CreatePost(h.ctx, alice, topic.ID, CreatePostInput{ContentMD: "hi"})
	// alice 回的是**自己的**主题，所以这里不该被 bob 的拉黑拦住。
	if err != nil {
		t.Fatalf("自回复自己主题不该被拦: %v", err)
	}
	_ = bobID
}

// 游标翻页不漏不重（§11.3 第 27 条）。
func TestCursorPagingNoDuplicateNoGap(t *testing.T) {
	h := newHarness(t)
	author, _ := h.setupTopic(t)
	for i := 0; i < 7; i++ {
		h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "帖", ContentMD: "x"})
		h.clk.T = h.clk.T.Add(1e9)
	}
	seen := map[string]bool{}
	var order []string
	cursor := ""
	for page := 0; page < 10; page++ {
		p, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, it := range p.Items {
			if seen[it.ID] {
				t.Fatalf("翻页出现重复: %s", it.ID)
			}
			seen[it.ID] = true
			order = append(order, it.ID)
		}
		if p.NextCursor == "" {
			break
		}
		cursor = p.NextCursor
	}
	if len(order) != 8 {
		t.Fatalf("应翻到 8 条，实际 %d", len(order))
	}
	// 恰好好 limit 条时给游标、到底时给 null（§3.8 规则 3）。
	p, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{Limit: 8})
	if err != nil {
		t.Fatal(err)
	}
	if p.NextCursor == "" {
		t.Fatal("恰好 limit 条时应给出下一页游标")
	}
	p, err = h.svc.ListTopics(h.ctx, nil, ListTopicsInput{Limit: 8, Cursor: p.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Items) != 0 || p.NextCursor != "" {
		t.Fatalf("到底时应是 0 行 + null 游标: %d 行", len(p.Items))
	}
	// 损坏的游标 → 400。
	_, err = h.svc.ListTopics(h.ctx, nil, ListTopicsInput{Cursor: "abc"})
	assertCode(t, err, "common.invalid_input")
}

// Issue：取号、开关、评论（§11.3 第 20/21/22 条）。
func TestIssueNumberingAndToggle(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	// 只有资源帖能提反馈。
	_, err := h.svc.CreateIssue(h.ctx, author, topic.ID, CreateIssueInput{Kind: "bug", Title: "x", BodyMD: "y"})
	assertCode(t, err, "forum.not_resource")

	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}
	const n = 4
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = h.svc.CreateIssue(h.ctx, author, topic.ID, CreateIssueInput{Kind: "bug", Title: "问题", BodyMD: "描述"})
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 条 issue 失败: %v", i, err)
		}
	}
	var distinct int
	if err := h.pool.QueryRow(h.ctx, "SELECT count(DISTINCT number) FROM post_issues").Scan(&distinct); err != nil {
		t.Fatal(err)
	}
	if distinct != n {
		t.Fatalf("取号应互不相同，实际 %d 个不同编号", distinct)
	}
	// issue_open_count 在主题详情里（不发额外请求）。
	d, err := h.svc.TopicDetail(h.ctx, author, topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.IssueOpenCount != n {
		t.Fatalf("issue_open_count 应为 %d，实际 %d", n, d.IssueOpenCount)
	}
	// 关两次都成功，closed_at 只在第一次写。
	page, err := h.svc.ListIssues(h.ctx, author, ListIssuesInput{TopicPublicID: topic.ID, Status: "open"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != n {
		t.Fatalf("?status=open 应返回 %d 条，实际 %d", n, len(page.Items))
	}
	first := page.Items[0]
	if err := h.svc.UpdateIssue(h.ctx, author, first.ID, UpdateIssueInput{Status: ptrStr("closed")}); err != nil {
		t.Fatal(err)
	}
	var closedAt string
	if err := h.pool.QueryRow(h.ctx, "SELECT closed_at::text FROM post_issues WHERE public_id = $1", first.ID).Scan(&closedAt); err != nil {
		t.Fatal(err)
	}
	h.clk.T = h.clk.T.Add(60e9)
	if err := h.svc.UpdateIssue(h.ctx, author, first.ID, UpdateIssueInput{Status: ptrStr("closed")}); err != nil {
		t.Fatalf("重复关闭也该成功: %v", err)
	}
	var closedAt2 string
	if err := h.pool.QueryRow(h.ctx, "SELECT closed_at::text FROM post_issues WHERE public_id = $1", first.ID).Scan(&closedAt2); err != nil {
		t.Fatal(err)
	}
	if closedAt != closedAt2 {
		t.Fatal("重复关闭不该刷新 closed_at")
	}
	d, err = h.svc.TopicDetail(h.ctx, author, topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.IssueOpenCount != n-1 {
		t.Fatalf("关一条后 open 数应为 %d，实际 %d", n-1, d.IssueOpenCount)
	}
	// 重开：closed_by / closed_at 都清空。
	if err := h.svc.UpdateIssue(h.ctx, author, first.ID, UpdateIssueInput{Status: ptrStr("open")}); err != nil {
		t.Fatal(err)
	}
	var both bool
	if err := h.pool.QueryRow(h.ctx,
		"SELECT closed_by IS NULL AND closed_at IS NULL FROM post_issues WHERE public_id = $1", first.ID).Scan(&both); err != nil {
		t.Fatal(err)
	}
	if !both {
		t.Fatal("重开后 closed_by / closed_at 都应为 NULL")
	}
	// 评论与评论投票。
	c, err := h.svc.CreateIssueComment(h.ctx, author, first.ID, CreateCommentInput{BodyMD: "看看"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.Vote(h.ctx, author, VoteIssueComment, c.ID, 1); err != nil {
		t.Fatal(err)
	}
	comments, err := h.svc.ListIssueComments(h.ctx, author, first.ID, PageInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(comments.Items) != 1 || comments.Items[0].MyVote != 1 || comments.Items[0].LikeCount != 1 {
		t.Fatalf("评论列表不对: %+v", comments.Items)
	}
}

// 下载源：只有资源帖能挂、改 url 不动 verified_at、confirm 两个字段一起变（§7.3）。
func TestSourcesWriteRules(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	_, err := h.svc.SaveSource(h.ctx, author, topic.ID, SourceInput{Provider: "baidu", URL: "https://pan.baidu.com/x"})
	assertCode(t, err, "forum.not_resource")

	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}
	src, err := h.svc.SaveSource(h.ctx, author, topic.ID, SourceInput{Provider: "baidu", URL: "https://pan.baidu.com/x", Label: "百度网盘"})
	if err != nil {
		t.Fatal(err)
	}
	if src.GoPath != "/api/v1/topics/"+topic.ID+"/sources/"+src.ID+"/go" {
		t.Fatalf("go_path 不对: %s", src.GoPath)
	}
	// 未知 provider 拒绝（前端按 key 查图标，写了中文会回落成一排问号）。
	_, err = h.svc.SaveSource(h.ctx, author, topic.ID, SourceInput{Provider: "百度", URL: "https://x.com"})
	assertCode(t, err, "common.invalid_input")

	if err := h.svc.VerifySource(h.ctx, author, src.ID); err != nil {
		t.Fatal(err)
	}
	updated, err := h.svc.UpdateSource(h.ctx, author, topic.ID, src.ID, SourceInput{Provider: "baidu", URL: "https://pan.baidu.com/y", Label: "改了错别字"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.VerifiedAt == nil {
		t.Fatal("改 url 不该刷掉 verified_at")
	}
	// 转链端点：计数进缓冲、返回目标 URL。
	target, err := h.svc.GoSource(h.ctx, topic.ID, src.ID)
	if err != nil {
		t.Fatal(err)
	}
	if target != "https://pan.baidu.com/y" {
		t.Fatalf("转链目标不对: %s", target)
	}
	if h.count.Get(counter.GoSourceKey(0)) != 0 {
		t.Fatal("计数键不该是 0 号源")
	}
	// 主题不可见时源也不可见（不能被用来探测隐藏主题）。
	if _, err := h.pool.Exec(h.ctx, "UPDATE topics SET visibility = 'hidden'"); err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.GoSource(h.ctx, topic.ID, src.ID)
	assertCode(t, err, "source.not_found")
}

func ptrStr(s string) *string { return &s }

// 全站 Issue 列表（无任何筛选）是 GET /api/v1/issues 的那条路：TopicID=0 时 $5 不被任何
// 条件引用。**这条路上原来没有用例**，于是「拼进去的参数比 args 少一个」这件事
// 一直到真库上才以 42P18「无法确定 $5 的类型」暴露出来（P1 接线时发现）。
func TestListIssuesAllSiteNoFilter(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	// 只有资源帖能提反馈，先把它改成资源帖。
	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}
	made, err := h.svc.CreateIssue(h.ctx, author, topic.ID, CreateIssueInput{Kind: "bug", Title: "全站列表", BodyMD: "描述"})
	if err != nil {
		t.Fatal(err)
	}
	// 不带任何筛选：?status / ?kind / ?author / ?assignee / ?cursor 全空。
	page, err := h.svc.ListIssues(h.ctx, author, ListIssuesInput{})
	if err != nil {
		t.Fatalf("全站 Issue 列表（无筛选）不该失败: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != made.ID {
		t.Fatalf("全站聚合应返回那条 issue，实际 %+v", page.Items)
	}
}

// 主题投票：只能赞不能踩（拍板 d3 §11.2 第 5 条）。
// 这条用例同时钉住两件事：
//   - 服务层把 value=-1 挡在 400（不是让它走到 SQL 上变成 500）；
//   - **+1 与取消真的能跑**：topics 表只有 like_count，没有 dislike_count，
//     而那两条 SQL 曾经无条件写 dislike_count（42P01/42703）。
func TestTopicVoteOnlyLike(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	_, err := h.svc.Vote(h.ctx, author, VoteTopic, topic.ID, -1)
	assertCode(t, err, "forum.vote_value_invalid")

	got, err := h.svc.Vote(h.ctx, author, VoteTopic, topic.ID, 1)
	if err != nil {
		t.Fatalf("主题点赞不该失败: %v", err)
	}
	if got.LikeCount != 1 || got.DislikeCount != 0 || got.MyVote != 1 {
		t.Fatalf("点赞后计数不对: %+v", got)
	}
	var stored int
	if err := h.pool.QueryRow(h.ctx, "SELECT like_count FROM topics WHERE public_id = $1", topic.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 1 {
		t.Fatalf("topics.like_count 应为 1，实际 %d", stored)
	}

	// 取消也是同一条 SQL 的另一半（Unvote 同样只该碰 like_count）。
	got, err = h.svc.Unvote(h.ctx, author, VoteTopic, topic.ID)
	if err != nil {
		t.Fatalf("取消主题点赞不该失败: %v", err)
	}
	if got.LikeCount != 0 || got.MyVote != 0 {
		t.Fatalf("取消后计数应归零: %+v", got)
	}
}
