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
	// 1 楼在列（顶层 = parent_id IS NULL 的口径），顶层回复老在前：第一条 → 第二条
	if len(page.Items) != 3 || page.Items[0].Floor != 1 || page.Items[1].Floor != 2 || page.Items[2].Floor != 3 {
		t.Fatalf("顶层回复应按 id 升序（老在上）: %+v", page.Items)
	}
	if page.Items[1].ID != first.ID || page.Items[2].ID != second.ID {
		t.Fatalf("顺序不对: %+v", page.Items)
	}

	// 游标方向：限制每页 1 条翻页，第一页给最老的（1 楼），next 翻下去是 2 楼、3 楼 —— 越翻越新。
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
	if len(page2.Items) != 1 || page2.Items[0].ID != first.ID {
		t.Fatalf("第二页接着第一条（越翻越新）: %+v", page2.Items)
	}
	if page2.NextCursor == "" {
		t.Fatalf("后面还有一条时该继续给游标")
	}
	page3, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID, Cursor: page2.NextCursor, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page3.Items) != 1 || page3.Items[0].ID != second.ID {
		t.Fatalf("第三页应到第一条新楼层并翻到底: %+v", page3.Items)
	}
	// 尾页的游标按 §3.8 规则 3 允许「取到了 limit 条就给」；再翻一格必须空页。
	page4, err := h.svc.ListPosts(h.ctx, author, ListPostsInput{TopicPublicID: topic.ID, Cursor: page3.NextCursor, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page4.Items) != 0 {
		t.Fatalf("游标翻到底后应空页: %+v", page4.Items)
	}
}
