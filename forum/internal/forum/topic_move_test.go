package forum

// 改分区（PATCH 带 board）的两条口径（2026-10-15 用户实测「修改帖子分区事实上无效」）：
//   · 有 topic.move：真的改得动（前端现在只在分区**变了**时才发 board）；
//   · 没有 topic.move：403，而且**分区没变** —— 权限检查与写库在同一个事务里（检查已挪到写之前），
//     这条同时钉住「拒绝时不会留下半次改动」。
// 超管由 actor.IsSuper 短路，不查 topic.move。
import (
	"testing"

	"forum/internal/authz"
)

func TestUpdateTopicBoardNeedsTopicMove(t *testing.T) {
	h := newHarness(t)
	h.seedBoard("general", 0, false)
	h.seedBoard("other", 0, false)

	// 只有 topic.edit.own 的作者（没有 topic.move）
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "主题", ContentMD: "正文"})

	err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{BoardSlug: ptrStr("other")})
	assertCode(t, err, "common.forbidden")
	after, err := h.svc.TopicDetail(h.ctx, author, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Board.Slug != "general" {
		t.Fatalf("被拒的分区改动不该落库：期望 general，实际 %s", after.Board.Slug)
	}

	// 同一个作者：只改标题（不带 board）照常能存 —— 前端「没改分区就不发 board」正是为了这一条
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{Title: ptrStr("改个标题")}); err != nil {
		t.Fatalf("不带 board 的保存不该被 topic.move 拦住：%v", err)
	}

	// 持 topic.move 的作者（超管走同一支：actor.IsSuper 短路）
	mover, _ := h.author("carol", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermTopicMove)
	carolTopic := h.mustTopic(mover, CreateTopicInput{BoardSlug: "general", Title: "她的帖", ContentMD: "正文"})
	if err := h.svc.UpdateTopic(h.ctx, mover, carolTopic.ID, UpdateTopicInput{BoardSlug: ptrStr("other")}); err != nil {
		t.Fatalf("有 topic.move 就该改得动：%v", err)
	}
	moved, err := h.svc.TopicDetail(h.ctx, mover, carolTopic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.Board.Slug != "other" {
		t.Fatalf("分区应当已改成 other，实际 %s", moved.Board.Slug)
	}
}
