package forum

import (
	"encoding/json"
	"testing"
)

// J4（拍板 08）：「reply_count 包含楼中楼」——这是**写死的口径**，不是实现细节。
//
// 口径（用户原话「包含」）：reply_count = 主题下**所有**帖子，除了 1 楼本身；
// 顶层回复与楼中楼一起算。用户眼里的「评论 128」就是全部回复，
// 「只有顶层」的数由 GET /topics/{id}/posts 的分页单独给。
//
// 这条用例的判据必须**只**由「含楼中楼」这个口径满足：
// 如果哪天有人把 pgsql.RecountTopic 的 floor > 1 改成 parent_id IS NULL，
// 第 ③ 步会红（旧口径下这里只有 1，不是 2）。
func TestReplyCountIncludesNestedReplies(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	// ① 一条顶层回复
	top, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "顶层回复"})
	if err != nil {
		t.Fatalf("发顶层回复失败: %v", err)
	}
	// ② 一条挂在它下面的楼中楼
	nested, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "楼中楼", ParentID: top.ID})
	if err != nil {
		t.Fatalf("发楼中楼失败: %v", err)
	}
	if nested.ParentID == nil || *nested.ParentID != top.ID {
		t.Fatalf("楼中楼的 parent_id 应是顶层回复: %+v", nested.ParentID)
	}

	// ③ 主题的 reply_count 必须把这两条一起数进去
	d, err := h.svc.TopicDetail(h.ctx, author, topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.ReplyCount != 2 {
		t.Fatalf("reply_count 含楼中楼，应为 2（1 顶层 + 1 楼中楼），实际 %d", d.ReplyCount)
	}
	// 列表卡片与详情同一个口径（两处都读 topics.reply_count，这条是防漂移的哨兵）
	page, err := h.svc.ListUserTopics(h.ctx, author, "alice", PageInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ReplyCount != 2 {
		t.Fatalf("列表卡片的 reply_count 应与详情一致: %+v", page.Items)
	}

	// ④ 删掉顶层回复之后：楼中楼不是被一起删掉，而是浮成顶层（posts.parent_id 是 ON DELETE SET NULL），
	// 所以「含楼中楼」的数从 2 变 1，而不是 0。
	if err := h.svc.DeletePost(h.ctx, author, top.ID); err != nil {
		t.Fatalf("删顶层回复失败: %v", err)
	}
	d, err = h.svc.TopicDetail(h.ctx, author, topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.ReplyCount != 1 {
		t.Fatalf("删掉顶层回复后应剩 1 条（浮起来的楼中楼），实际 %d", d.ReplyCount)
	}
}

// J7（拍板 08）：§3.3 的「Issue 列表项必须自带的 5 个字段」逐条核实。
//
// W1 实测的判据是「缺任一项前端都得再发一次请求」（撞 §9.1 首屏请求数 ≤ 10），
// 所以这里**数 JSON 的键**，不看 Go 结构体 —— 结构体里有、序列化时被 omitempty 吃掉
// 是本仓库的高频事故形态（parent_id / my_vote 都中过）。
//
// 五个字段：status / comment_count / created_at / updated_at / author{handle,nickname,avatar_hash}。
func TestIssueCardCarriesTheFiveRequiredFields(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	// Issue 只挂在资源帖上（§7.6：ref.Kind 必须是 resource），所以先把它改成资源帖。
	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}

	created, err := h.svc.CreateIssue(h.ctx, author, topic.ID, CreateIssueInput{
		Kind: "bug", Title: "打到一半卡住", BodyMD: "第三章第二波",
	})
	if err != nil {
		t.Fatalf("提 Issue 失败: %v", err)
	}
	if _, err := h.svc.CreateIssueComment(h.ctx, author, created.ID, CreateCommentInput{BodyMD: "我这也一样"}); err != nil {
		t.Fatalf("发评论失败: %v", err)
	}

	page, err := h.svc.ListIssues(h.ctx, author, ListIssuesInput{TopicPublicID: topic.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("应有 1 条 Issue，实际 %d", len(page.Items))
	}
	assertIssueCardFields(t, "列表", page.Items[0])

	detail, err := h.svc.IssueDetail(h.ctx, author, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertIssueCardFields(t, "详情", detail.IssueDTO)
}

// assertIssueCardFields 把一条 IssueDTO 序列化成前端真正收到的 JSON，再逐个数键。
func assertIssueCardFields(t *testing.T, where string, d IssueDTO) {
	t.Helper()
	raw, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	// ① status ② comment_count ③ created_at ④ updated_at ⑤ author{handle,nickname,avatar_hash}
	for _, k := range []string{"status", "comment_count", "created_at", "updated_at", "author"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("%s 的 Issue 卡片缺字段 %q（§3.3 的 5 个必须自带的字段）: %s", where, k, raw)
		}
	}
	author, ok := m["author"].(map[string]any)
	if !ok {
		t.Fatalf("%s 的 author 不是对象: %s", where, raw)
	}
	for _, k := range []string{"handle", "nickname", "avatar_hash"} {
		if _, ok := author[k]; !ok {
			t.Fatalf("%s 的 author 缺字段 %q: %s", where, k, raw)
		}
	}
	if s, _ := m["status"].(string); s != "open" && s != "closed" {
		t.Fatalf("%s 的 status 只能是 open/closed，实际 %q", where, m["status"])
	}
	if n, _ := m["comment_count"].(float64); int(n) != 1 {
		t.Fatalf("%s 的 comment_count 应为 1，实际 %v", where, m["comment_count"])
	}
}

// J9（拍板 08）：卡片上的封面必须带真实宽高（§4.2）。
//
// 为什么非要它：前端拿到一张 48×48 的图标当封面会糊成一片，而**图的真实尺寸只有后端知道**；
// 没有宽高就只能等浏览器解码后量 naturalWidth（多一次布局判定，且违反 CLS 的宽高比容器要求）。
//
// 判据是「后端从 images 表读出来的数」，不是「DTO 里有这两个字段」：
// 0 在这条路上只有一个含义 —— 这张主题没有封面（topic_images 里 sort=0 的那张）。
func TestTopicCardCarriesCoverDimensions(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	// 没有封面的主题：宽高 0，cover_hash 空（前端据此走占位块）
	d, err := h.svc.TopicDetail(h.ctx, author, topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.CoverHash != "" || d.CoverWidth != 0 || d.CoverHeight != 0 {
		t.Fatalf("无封面的主题不该有尺寸: cover=%q %dx%d", d.CoverHash, d.CoverWidth, d.CoverHeight)
	}

	// 挂一张 1600×900 的封面（sort=0 就是封面，见 coverJoin）
	hash := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO images (hash, size, mime, width, height) VALUES ($1, 1, 'image/webp', 1600, 900)", hash); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, `
INSERT INTO topic_images (topic_id, post_id, image_hash, sort)
SELECT t.id, p.id, $2, 0 FROM topics t JOIN posts p ON p.topic_id = t.id AND p.floor = 1
 WHERE t.public_id = $1`, topic.ID, hash); err != nil {
		t.Fatal(err)
	}

	d, err = h.svc.TopicDetail(h.ctx, author, topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.CoverHash != hash {
		t.Fatalf("cover_hash 应为 %s，实际 %q", hash, d.CoverHash)
	}
	if d.CoverWidth != 1600 || d.CoverHeight != 900 {
		t.Fatalf("cover 应为 1600x900，实际 %dx%d（图的实际尺寸只有后端知道，必须由后端给）",
			d.CoverWidth, d.CoverHeight)
	}
}
