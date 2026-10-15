package forum

import (
	"testing"

	"forum/internal/authz"
)

// 找一项回复是否在分页里（一段就一页，测试放的回复少于一页）。
func listHasPost(items []PostDTO, id string) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}

// D64（2026-10-15 用户实测「删除的评论用户侧仍显示」）：
// TopLevelReplies 旧谓词带一个作者例外（p.author_id = viewer）：作者自己软删的顶层回复，
// 在**他自己的列表里仍然出现**，而 PostDTO 没有 visibility 字段 —— 前端只能把它照普通评论渲染，
// 于是「删了等于没删」。现在列表对所有人一个口径：非 normal 的楼层谁都不列
// （单条寻址 postRef 保留作者例外，是给分享链接与直接 API 调用用的）。
func TestDeletedReplyVanishesFromListForItsAuthor(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	other, _ := h.author("bobby", 5, true, authz.PermTopicCreate)

	top, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "顶层"})
	if err != nil {
		t.Fatalf("发回复失败: %v", err)
	}
	if err := h.svc.DeletePost(h.ctx, author, top.ID); err != nil {
		t.Fatalf("作者删自己的回复失败: %v", err)
	}

	// 作者自己的列表里不再出现这条（旧行为会因作者例外把它平平常常地列回来）
	page, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID})
	if err != nil {
		t.Fatal(err)
	}
	if listHasPost(page.Items, top.ID) {
		t.Fatalf("作者删掉的回复不该再出现在自己的列表里: %+v", page.Items)
	}
	// 别人同样看不到（这条本就该过滤，钉住别在改谓词时回归）
	page2, err := h.svc.ListPosts(h.ctx, other, ListPostsInput{TopicPublicID: topic.ID})
	if err != nil {
		t.Fatal(err)
	}
	if listHasPost(page2.Items, top.ID) {
		t.Fatalf("旁人的列表不该有已删回复: %+v", page2.Items)
	}
	// reply_count 同步收敛到 0（RecountTopic 在删除路径上已跑，这里是防漂移的口径核对）
	if n := h.countRows(t, "SELECT reply_count FROM topics WHERE public_id = $1", topic.ID); n != 0 {
		t.Fatalf("删除后主题的 reply_count 应为 0，实际 %d", n)
	}
}

// D66（2026-10-15 用户实测「评论区新评论在上，应老评论在上」）：
// 顶层回复按 **id 升序** 列（老楼层在前），排序键与游标方向一起翻——第一页从最老开始，
// 续页游标指向「取到的最后一条」，向后越翻越新。楼层键是 identity id：与 created_at 同序但单列。
func TestTopLevelRepliesListOldestFirst(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	first, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "第一条"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "第二条"})
	if err != nil {
		t.Fatal(err)
	}

	page, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID})
	if err != nil {
		t.Fatal(err)
	}
	// 1 楼是主题正文不进评论区（D71，列表口径与 reply_count 一致都数 floor > 1），顶层回复老在前：第一条 → 第二条
	if len(page.Items) != 2 || page.Items[0].Floor != 2 || page.Items[1].Floor != 3 {
		t.Fatalf("顶层回复应按 id 升序（老在上）: %+v", page.Items)
	}
	if page.Items[0].ID != first.ID || page.Items[1].ID != second.ID {
		t.Fatalf("顺序不对: %+v", page.Items)
	}

	// 游标方向：限制每页 1 条翻页，第一页给最老的一条（第一条回复），next 翻下去是第二条 —— 越翻越新。
	page1, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page1.Items) != 1 || page1.Items[0].ID != page.Items[0].ID {
		t.Fatalf("第一页应从最老的一条起: %+v", page1.Items)
	}
	if page1.NextCursor == "" {
		t.Fatalf("还有下一条时应给游标")
	}
	page2, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID, Cursor: page1.NextCursor, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page2.Items) != 1 || page2.Items[0].ID != second.ID {
		t.Fatalf("第二页接着第二条（越翻越新）: %+v", page2.Items)
	}
	// 尾页的游标按 §3.8 规则 3 允许「取到了 limit 条就给」；再翻一格必须空页。
	page3, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID, Cursor: page2.NextCursor, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page3.Items) != 0 {
		t.Fatalf("游标翻到底后应空页: %+v", page3.Items)
	}
}

// D71（用户原话「帖子正文不应该出现在评论区」）：1 楼是主题正文不是回复。
// roots 把「parent_id IS NULL」的 1 楼也当顶层回复列出来，评论区第一条其实是正文，
// 而 reply_count 一直按 floor > 1 数（pgsql.RecountTopic 写死的口径）——列表与计数对不上。
func TestListPostsExcludesTopicBody(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	reply, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "顶层回复"})
	if err != nil {
		t.Fatal(err)
	}

	// 1 楼是发主题时落进 posts 的正文行（§4.2），拿它的 public_id 当判据。
	var bodyID string
	if err := h.pool.QueryRow(h.ctx, `
SELECT p.public_id FROM posts p JOIN topics t ON t.id = p.topic_id
 WHERE t.public_id = $1 AND p.floor = 1`, topic.ID).Scan(&bodyID); err != nil {
		t.Fatal(err)
	}

	page, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != reply.ID {
		t.Fatalf("评论区应只有那条回复: %+v", page.Items)
	}
	if listHasPost(page.Items, bodyID) {
		t.Fatalf("1 楼是主题正文，不该出现在评论区: %+v", page.Items)
	}
	// 口径哨兵：列表列的就是 reply_count 数的那些楼，两者必须一致。
	if n := h.countRows(t, "SELECT reply_count FROM topics WHERE public_id = $1", topic.ID); n != len(page.Items) {
		t.Fatalf("回复列表长度 %d 应与 reply_count %d 一致", len(page.Items), n)
	}
}

// D71：「回复正文就是回复帖子」。CreatePost 曾允许 parent 指向 1 楼（正文），那些楼
// 挂在正文名下——正文从评论区摘除后就成了没有挂点的孤儿；parent 是正文时按顶层回复落库。
func TestReplyToTopicBodyIsTopLevel(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	var bodyID string
	if err := h.pool.QueryRow(h.ctx, `
SELECT p.public_id FROM posts p JOIN topics t ON t.id = p.topic_id
 WHERE t.public_id = $1 AND p.floor = 1`, topic.ID).Scan(&bodyID); err != nil {
		t.Fatal(err)
	}

	reply, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "回复正文", ParentID: bodyID})
	if err != nil {
		t.Fatalf("回复主题正文应该按「回复主题」处理: %v", err)
	}
	if reply.ParentID != nil {
		t.Fatalf("回复正文应落为顶层回复（parent_id = NULL），实际指向 %s", *reply.ParentID)
	}
	// 库里的形状钉住：正文名下不再挂楼。
	if n := h.countRows(t, "SELECT count(*) FROM posts WHERE parent_id IS NOT NULL"); n != 0 {
		t.Fatalf("正文名下应无挂楼，实际 %d", n)
	}
}
