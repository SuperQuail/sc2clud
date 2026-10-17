package forum

import (
	"testing"

	"forum/internal/authz"
)

// 软删的正文行（posts.floor=1 的 visibility='deleted'）必须能被「作者重新写正文」救回来。
//
// 用户实测：一篇正文被删过的帖子，**任何编辑都改不动正文、强制刷新也不行** —— 页面永远显示
// 「正文已被作者删除」。根因是两条写正文的路径都只写 content_*，visibility 一直停在 deleted：
//
//	· 没过审的帖（pending / rejected）：编辑直接写 posts（pgsql.UpdatePostContent）；
//	· 已过审的帖：编辑进待审槽，**放行那一刻**才替换（pgsql.PromotePendingRevision）。
//
// 两条都钉在这里。「正文可被删除」已被判为错误设计：删楼层那条路现在拒绝 floor = 1，
// 这个状态只可能来自迁移 0061 之前的历史数据（旧行还在库里），所以恢复是防御、不是主路径。
func TestEditingRejectedTopicRevivesDeletedBody(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	reviewer, _ := h.author("mod", 5, true, authz.PermPostReview)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1"})

	if _, err := h.svc.ReviewTopic(h.ctx, reviewer, d.ID, ReviewReject, "先改改再发"); err != nil {
		t.Fatal(err)
	}
	h.softDeleteBody(t, d.ID)

	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V2")}); err != nil {
		t.Fatal(err)
	}
	if got := h.postMD(t, d.ID); got != "V2" {
		t.Fatalf("没过审的帖，编辑应直接写 posts，实际 %q", got)
	}
	if got := h.bodyVisibility(t, d.ID); got != "normal" {
		t.Fatalf("作者重新写了正文，正文行必须恢复可见，实际 visibility=%q —— 页面上会一直是「正文已被作者删除」", got)
	}
}

func TestApprovingRevisionRevivesDeletedBody(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermPostReview)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1"})
	if d.ReviewState != "approved" {
		t.Fatalf("前提不成立：持 post.review 的作者发的帖应直接过审，实际 %s", d.ReviewState)
	}

	h.softDeleteBody(t, d.ID)
	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V2")}); err != nil {
		t.Fatal(err)
	}
	// 前提：改动进待审槽，线上正文一个字没动（拍板 08 · 6.2 的「通过再替换」）
	if got := h.postMD(t, d.ID); got != "V1" {
		t.Fatalf("编辑不动原帖：posts 里应还是 V1，实际 %q", got)
	}
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	if got := h.postMD(t, d.ID); got != "V2" {
		t.Fatalf("放行后线上正文应换成 V2，实际 %q", got)
	}
	if got := h.bodyVisibility(t, d.ID); got != "normal" {
		t.Fatalf("放行改动就是让它上台可见：正文行必须恢复可见，实际 visibility=%q（读者看到的仍是「已删除」）", got)
	}
}

// softDeleteBody 造的是历史残留（删楼层那条路已拒绝 floor = 1），
// 用 DeletePostRow 写的那一条语句，不另写一份「删除」语义。
func (h *harness) softDeleteBody(t *testing.T, topicPublicID string) {
	t.Helper()
	if _, err := h.pool.Exec(h.ctx,
		"UPDATE posts SET visibility = 'deleted' WHERE topic_id = (SELECT id FROM topics WHERE public_id = $1::uuid) AND floor = 1",
		topicPublicID); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) bodyVisibility(t *testing.T, topicPublicID string) string {
	t.Helper()
	var v string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT visibility FROM posts WHERE topic_id = (SELECT id FROM topics WHERE public_id = $1::uuid) AND floor = 1",
		topicPublicID).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}
