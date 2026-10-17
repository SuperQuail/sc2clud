package forum

import (
	"testing"

	"forum/internal/platform/apperr"
)

// 产品设计反转（用户定调：「正文出现在评论区」与「正文可被删除」是错误设计）：
// posts.floor = 1 是主题正文，不是评论。
//
// 删楼层这条路必须拒绝它 —— 放行只会留下「正文已被作者删除」的半死状态（标题还在、正文没了），
// 而用户实测那个状态**任何编辑都救不回来**（D79 的两处 visibility 恢复与迁移 0061 才补上）。
// 要删整帖走删主题那条路，那条路连标题一起删。
func TestDeletingTopicBodyIsRejected(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	var bodyID string
	if err := h.pool.QueryRow(h.ctx, "SELECT p.public_id FROM posts p JOIN topics t ON t.id = p.topic_id WHERE t.public_id = $1 AND p.floor = 1", topic.ID).Scan(&bodyID); err != nil {
		t.Fatal(err)
	}
	reply, err := h.svc.CreatePost(h.ctx, author, topic.ID, CreatePostInput{ContentMD: "顶层回复"})
	if err != nil {
		t.Fatal(err)
	}

	ae := mustAppErr(t, h.svc.DeletePost(h.ctx, author, bodyID))
	if ae.Code != apperr.CodeInvalidInput {
		t.Fatalf("正文不是回复：应是参数错误（%s），实际 %s", apperr.CodeInvalidInput, ae.Code)
	}
	if ae.Fields["id"] == "" {
		t.Fatalf("拒绝的理由要落在 id 上（前端按字段名挂提示），实际 %+v", ae.Fields)
	}
	// 拒绝必须是「什么都没做」：行仍在、仍 normal、正文一个字没少。
	if got := h.bodyVisibility(t, topic.ID); got != "normal" {
		t.Fatalf("拒绝之后正文行的 visibility 必须还是 normal，实际 %q", got)
	}
	if got := h.postMD(t, topic.ID); got != "正文" {
		t.Fatalf("拒绝之后正文必须原样在，实际 %q", got)
	}

	// 入口没被一刀切：删正常回复照旧成功，reply_count 跟着减。
	if n := h.countRows(t, "SELECT reply_count FROM topics WHERE public_id = $1", topic.ID); n != 1 {
		t.Fatalf("删除前 reply_count 应为 1，实际 %d", n)
	}
	if err := h.svc.DeletePost(h.ctx, author, reply.ID); err != nil {
		t.Fatalf("删正常回复必须照旧可用: %v", err)
	}
	if n := h.countRows(t, "SELECT reply_count FROM topics WHERE public_id = $1", topic.ID); n != 0 {
		t.Fatalf("删掉回复后 reply_count 应为 0，实际 %d", n)
	}
}
