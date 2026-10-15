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
