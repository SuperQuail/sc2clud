package forum

import (
	"testing"

	"forum/internal/authz"
)

// 0028 的快照写入本身：**批准一个已经过审的主题**时，1 楼正文进 topic_revisions。
//
// 从 L6 的大用例里拆出来单独钉一次，因为它的失败形态很难看：revision_of 恒空、
// 而「打回」照样成功 —— 从外面看只是「作者看不到上一版」，容易当成前端没渲染。
func TestApprovingAnApprovedTopicSnapshotsTheRevision(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermPostReview)
	h.seedBoard("general", 0, false)
	// 持 post.review 的作者发的帖**直接就是 approved**（审核豁免，拍板 §2.2 第 1 条）。
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1"})

	// ① 首次批准（上一态已是 approved）：1 楼正文 V1 成为「过审版本」。
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	if got := h.revisionMD(t, d.ID); got != "V1" {
		t.Fatalf("过审版本应是 V1，实际 %q", got)
	}

	// ② 幂等：再批一次**不覆盖**。approved_at 说的是「这份内容什么时候被批准」，
	//    覆盖会让那个时间戳说谎（快照的 SQL 用 NOT EXISTS 而不是 ON CONFLICT 就是为了这个）。
	if _, err := h.svc.ReviewTopic(h.ctx, author, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	if n := h.countRevisions(t, d.ID); n != 1 {
		t.Fatalf("一帖一份，实际 %d 行", n)
	}
	if got := h.revisionMD(t, d.ID); got != "V1" {
		t.Fatalf("重复批准不该改快照，实际 %q", got)
	}
}

// TestSnapshotIsNotTakenForANeverApprovedTopic 钉「pending 的新帖第一次被批准」不写快照：
// 那种情况下它此前**没有过审版本**，写一份「过审之前的正文」进去会让
// 「最后过审版本」变成一句假话（作者会在 revision_of 里看到自己还没被批过的那一版）。
func TestSnapshotIsNotTakenForANeverApprovedTopic(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 5, false, authz.PermTopicCreate) // 非 trusted + 无 post.review → 发帖进 pending
	reviewer, _ := h.author("mod", 5, true, authz.PermPostReview)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "x", ContentMD: "V1"})
	if d.ReviewState != "pending" {
		t.Fatalf("前提不成立：普通作者的新帖应当是 pending，实际 %s", d.ReviewState)
	}
	if _, err := h.svc.ReviewTopic(h.ctx, reviewer, d.ID, ReviewApprove, ""); err != nil {
		t.Fatal(err)
	}
	if n := h.countRevisions(t, d.ID); n != 0 {
		t.Fatalf("首次批准的帖此前没有过审内容，不该写快照，实际 %d 行", n)
	}
}

func (h *harness) countRevisions(t *testing.T, topicPublicID string) int {
	t.Helper()
	var n int
	if err := h.pool.QueryRow(h.ctx, `
SELECT count(*) FROM topic_revisions r
  JOIN topics t ON t.id = r.topic_id WHERE t.public_id = $1`, topicPublicID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (h *harness) revisionMD(t *testing.T, topicPublicID string) string {
	t.Helper()
	var md string
	if err := h.pool.QueryRow(h.ctx, `
SELECT r.content_md FROM topic_revisions r
  JOIN topics t ON t.id = r.topic_id WHERE t.public_id = $1`, topicPublicID).Scan(&md); err != nil {
		t.Fatal(err)
	}
	return md
}
