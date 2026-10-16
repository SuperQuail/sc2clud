package forum

import (
	"errors"
	"testing"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// 0062_issue_archive：Issue 被 AI / 管理员归档之后，
//   - 三个公共读口（帖内列表 / 全局列表 / 详情）都看不到它；
//   - 非管理员访问它的详情 = 404（与不存在同形：不暴露「它被藏了」）；
//   - 管理端列表按 archived=1 看得到它、restore 之后它又出现在公共读口。
//
// 「归档」不是删除：正文、评论、编号全在库里，只是公共读口隐身。

func (h *harness) mustIssue(actor *authz.Actor, topicPublicID string, in CreateIssueInput) *IssueDTO {
	h.t.Helper()
	d, err := h.svc.CreateIssue(h.ctx, actor, topicPublicID, in)
	if err != nil {
		h.t.Fatalf("提 Issue 失败: %v", err)
	}
	return d
}

// issueInPage 问「这一页里有没有这条 Issue」。
func issueInPage(page *IssuePage, publicID string) bool {
	for _, it := range page.Items {
		if it.ID == publicID {
			return true
		}
	}
	return false
}

func TestIssueArchiveHidesFromPublicReadsAndAdminCanRestore(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	// 默认 kind 是 post；Issue 只挂在资源帖下（CreateIssue 的 ErrNotResource）。
	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}
	reporter, _ := h.author("reporter", 3, true, authz.PermTopicCreate)
	iss := h.mustIssue(reporter, topic.ID, CreateIssueInput{Kind: "bug", Title: "卡关", BodyMD: "第二波就卡"})

	// 管理员（post.review）——把「谁能看归档」这条判据钉在权限点上。
	adminActor, admin := h.author("admin", 4, false, authz.PermPostReview)

	// ① 归档之前：三个公共读口都看得到它，详情里也有 issue_open_count。
	list, err := h.svc.ListIssues(h.ctx, nil, ListIssuesInput{})
	if err != nil {
		t.Fatal(err)
	}
	if !issueInPage(list, iss.ID) {
		t.Fatalf("归档前全局列表该有它，实际 %+v", list.Items)
	}
	if _, err := h.svc.IssueDetail(h.ctx, nil, iss.ID); err != nil {
		t.Fatalf("归档前详情该可读: %v", err)
	}

	// ② 归档（带理由）
	if err := h.svc.ArchiveIssue(h.ctx, adminActor, iss.ID, ArchiveIssueInput{Reason: "广告引流"}); err != nil {
		t.Fatalf("归档: %v", err)
	}
	var archivedAt *string
	var archivedBy *int64
	var reason string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT archived_at::text, archived_by, archive_reason FROM post_issues WHERE public_id = $1::uuid", iss.ID).
		Scan(&archivedAt, &archivedBy, &reason); err != nil {
		t.Fatal(err)
	}
	if archivedAt == nil || reason != "广告引流" || archivedBy == nil || *archivedBy != admin {
		t.Fatalf("归档三列不对: at=%v by=%v reason=%q", archivedAt, archivedBy, reason)
	}
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = 'issue.archive' AND target_id = $1", iss.ID); n != 1 {
		t.Fatalf("归档该写一条审计，实际 %d 条", n)
	}

	// ③ 三个公共读口都不出现它
	list, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{})
	if err != nil {
		t.Fatal(err)
	}
	if issueInPage(list, iss.ID) {
		t.Fatal("全局列表不该出现已归档的 Issue")
	}
	topicList, err := h.svc.ListIssues(h.ctx, nil, ListIssuesInput{TopicPublicID: topic.ID})
	if err != nil {
		t.Fatal(err)
	}
	if issueInPage(topicList, iss.ID) {
		t.Fatal("帖内列表不该出现已归档的 Issue")
	}
	// 详情：普通读者 404（与不存在同形），管理员看得见
	if _, err := h.svc.IssueDetail(h.ctx, nil, iss.ID); !errors.Is(err, ErrIssueNotFound) {
		t.Fatalf("已归档的详情对普通读者该 404，实际 %v", err)
	}
	if _, err := h.svc.IssueDetail(h.ctx, adminActor, iss.ID); err != nil {
		t.Fatalf("管理员该看得见已归档的详情: %v", err)
	}
	// 评论也一样（评论文本是对外可读的，不该从这条侧门漏出去）
	if _, err := h.svc.ListIssueComments(h.ctx, nil, iss.ID, PageInput{}); !errors.Is(err, ErrIssueNotFound) {
		t.Fatalf("已归档的评论列表对普通读者该 404，实际 %v", err)
	}
	// 话题页徽标（issue_open_count）也不该再算它
	if _, err := h.svc.CreateIssue(h.ctx, reporter, topic.ID, CreateIssueInput{Kind: "bug", Title: "另一条", BodyMD: "还没归档"}); err != nil {
		t.Fatal(err)
	}
	detail, err := h.svc.TopicDetail(h.ctx, author, topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.IssueOpenCount != 1 {
		t.Fatalf("issue_open_count 该只数未归档的（1），实际 %d", detail.IssueOpenCount)
	}

	// ④ 管理端列表：缺省看不到归档的；archived=1 看得到；counts 三档
	page, err := h.svc.ListAdminIssues(h.ctx, adminActor, AdminIssueInput{})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range page.Items {
		if it.ID == iss.ID {
			t.Fatal("管理端缺省（archived=0）不该出现已归档的")
		}
	}
	if page.Counts.Archived != 1 || page.Counts.Active != 1 || page.Counts.All != 2 {
		t.Fatalf("counts 三档不对: %+v", page.Counts)
	}
	page, err = h.svc.ListAdminIssues(h.ctx, adminActor, AdminIssueInput{Archived: "1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != iss.ID {
		t.Fatalf("archived=1 该只有那一条，实际 %+v", page.Items)
	}
	got := page.Items[0]
	if got.ArchiveReason != "广告引流" || got.ArchivedAt == nil || got.ArchivedBy == nil ||
		got.ArchivedBy.Handle != "admin" {
		t.Fatalf("管理端列表的归档字段不对: %+v", got)
	}
	if got.Status != "keep_open" || got.BodyHTML == "" || got.Topic.ID != topic.ID {
		t.Fatalf("管理端列表的形状不对: %+v", got)
	}
	// archived=all 两条都在
	page, err = h.svc.ListAdminIssues(h.ctx, adminActor, AdminIssueInput{Archived: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("archived=all 该两条，实际 %d", len(page.Items))
	}
	// 不认识的 archived 值 → 400，不静默当默认
	if _, err := h.svc.ListAdminIssues(h.ctx, adminActor, AdminIssueInput{Archived: "yes"}); err == nil {
		t.Fatal("archived=yes 该 400")
	}
	// 没有 post.review 的人拿不到管理端列表（service 层兜底）
	if _, err := h.svc.ListAdminIssues(h.ctx, nil, AdminIssueInput{}); !errors.Is(err, apperr.ErrUnauthorized) {
		t.Fatalf("游客该 401，实际 %v", err)
	}
	if _, err := h.svc.ListAdminIssues(h.ctx, reporter, AdminIssueInput{}); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("普通用户该 403，实际 %v", err)
	}

	// ⑤ 恢复：又出现在公共读口，归档三列清空，审计多一条
	if err := h.svc.RestoreIssue(h.ctx, adminActor, iss.ID); err != nil {
		t.Fatalf("恢复: %v", err)
	}
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = 'issue.restore' AND target_id = $1", iss.ID); n != 1 {
		t.Fatalf("恢复该写一条审计，实际 %d 条", n)
	}
	if n := h.countRows(t, "SELECT count(*) FROM post_issues WHERE public_id = $1::uuid AND archived_at IS NULL AND archived_by IS NULL AND archive_reason = ''", iss.ID); n != 1 {
		t.Fatalf("恢复该把归档三列清空")
	}
	list, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{})
	if err != nil {
		t.Fatal(err)
	}
	if !issueInPage(list, iss.ID) {
		t.Fatal("恢复之后它该回到全局列表")
	}
	if _, err := h.svc.IssueDetail(h.ctx, nil, iss.ID); err != nil {
		t.Fatalf("恢复之后详情该对普通读者可读: %v", err)
	}

	// ⑥ 幂等：已经恢复的那条再恢复一次 = 成功但不写第二份审计
	if err := h.svc.RestoreIssue(h.ctx, adminActor, iss.ID); err != nil {
		t.Fatalf("重复恢复该成功: %v", err)
	}
	if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = 'issue.restore' AND target_id = $1", iss.ID); n != 1 {
		t.Fatalf("重复恢复不该写第二条审计，实际 %d 条", n)
	}
	// 不存在的 id / 非 uuid → 404（与公共详情同形）
	if err := h.svc.ArchiveIssue(h.ctx, adminActor, "00000000-0000-0000-0000-000000000000", ArchiveIssueInput{}); !errors.Is(err, ErrIssueNotFound) {
		t.Fatalf("不存在的 Issue 该 404，实际 %v", err)
	}
	if err := h.svc.RestoreIssue(h.ctx, adminActor, "not-a-uuid"); !errors.Is(err, ErrIssueNotFound) {
		t.Fatalf("非 uuid 该 404（不是 500），实际 %v", err)
	}
}
