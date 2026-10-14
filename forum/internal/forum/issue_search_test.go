package forum

import (
	"testing"

	"forum/internal/authz"
)

// J5（拍板 08）：「完善issue检索,完整实现」—— 界面施工 §3.1 的四个筛选 + §3.1.1 的跨主题聚合。
//
// 这条用例逐条钉住 §3.1 的参数：q（中文两字词）、status、kind、author，以及 §3.1 要求的排序
// （最新 / 最早 / 评论最多）。旧行为下 q 与 sort=old 根本不存在 —— 用例连编译都过不去。
func TestIssueSearchAndFilters(t *testing.T) {
	h := newHarness(t)
	// 两块分区两条资源帖，让「跨主题聚合」有东西可聚合。
	author, t1 := h.setupTopic(t)
	if err := h.svc.UpdateTopic(h.ctx, author, t1.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}
	h.seedBoard("other", 0, false)
	t2 := h.mustTopic(author, CreateTopicInput{BoardSlug: "other", Title: "另一帖", ContentMD: "x"})
	if err := h.svc.UpdateTopic(h.ctx, author, t2.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}
	reporter, _ := h.author("reporter", 3, true, authz.PermTopicCreate)

	// 三条 issue：中文两字词「卡关」只在第一条的**正文**里（标题里没有）。
	a, err := h.svc.CreateIssue(h.ctx, reporter, t1.ID, CreateIssueInput{Kind: "bug", Title: "第三章崩了", BodyMD: "走到第二波就卡关"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.svc.CreateIssue(h.ctx, reporter, t1.ID, CreateIssueInput{Kind: "feature", Title: "想要存档", BodyMD: "希望加个自动存档"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := h.svc.CreateIssue(h.ctx, author, t2.ID, CreateIssueInput{Kind: "bug", Title: "另一帖的崩", BodyMD: "同样崩"})
	if err != nil {
		t.Fatal(err)
	}
	// 给 b 加两条评论，让 sort=comments 有区分度
	for i := 0; i < 2; i++ {
		if _, err := h.svc.CreateIssueComment(h.ctx, reporter, b.ID, CreateCommentInput{BodyMD: "同求"}); err != nil {
			t.Fatal(err)
		}
	}
	// 关掉 c，让 status 筛选有区分度
	if err := h.svc.UpdateIssue(h.ctx, author, c.ID, UpdateIssueInput{Status: ptrStr("closed")}); err != nil {
		t.Fatal(err)
	}

	ids := func(page *IssuePage) map[string]bool {
		out := map[string]bool{}
		for _, it := range page.Items {
			out[it.ID] = true
		}
		return out
	}

	// ① q：中文两字词命中**正文**（标题里没有「卡关」两个字）
	page, err := h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Q: "卡关"})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(page); len(got) != 1 || !got[a.ID] {
		t.Fatalf("q=卡关 应只命中正文里那条，实际 %v", got)
	}
	// ② q 同时搜标题
	page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Q: "存档"})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(page); len(got) != 1 || !got[b.ID] {
		t.Fatalf("q=存档 应只命中标题里那条，实际 %v", got)
	}
	// ③ q 与 kind 组合（跨主题聚合上做）
	page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Kind: "bug"})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(page); len(got) != 2 || !got[a.ID] || !got[c.ID] {
		t.Fatalf("kind=bug 应命中两条（跨主题），实际 %v", got)
	}
	// ④ status 筛选：open 不含已关的 c
	page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Status: "open"})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(page); got[c.ID] {
		t.Fatalf("status=open 不该含已关闭的，实际 %v", got)
	}
	page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Status: "closed"})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(page); len(got) != 1 || !got[c.ID] {
		t.Fatalf("status=closed 应只有 c，实际 %v", got)
	}
	// ⑤ author 筛选（handle）
	page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Author: "reporter"})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(page); len(got) != 2 || got[c.ID] {
		t.Fatalf("author=reporter 应是 a+b，实际 %v", got)
	}
	// ⑥ 单主题列表也带 q（§3.1 的端点就是这一条）
	page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{TopicPublicID: t1.ID, Q: "卡关"})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(page); len(got) != 1 || !got[a.ID] {
		t.Fatalf("单主题列表也要支持 q，实际 %v", got)
	}

	// ⑦ 排序：comments（评论最多的在前）——comments 只允许首页（没有游标）
	page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Sort: "comments"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) == 0 || page.Items[0].ID != b.ID {
		t.Fatalf("sort=comments 应把 b（2 条评论）排第一，实际 %+v", page.Items)
	}
	// ⑧ sort=old：**最早创建**在前（§3.1 的 old；旧行为下这个值直接 400）
	page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Sort: "old"})
	if err != nil {
		t.Fatalf("sort=old 必须被接受（§3.1 的最早）: %v", err)
	}
	if len(page.Items) != 3 || page.Items[0].ID != a.ID {
		t.Fatalf("sort=old 应把最早创建的 a 排第一，实际 %+v", page.Items)
	}
	// ⑨ sort=new 与 created 同义（需求里的写法与已发货的名字）
	for _, s := range []string{"new", "created"} {
		page, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Sort: s})
		if err != nil {
			t.Fatalf("sort=%s 应被接受: %v", s, err)
		}
		if len(page.Items) != 3 || page.Items[0].ID != c.ID {
			t.Fatalf("sort=%s 应把最新的 c 排第一，实际 %+v", s, page.Items)
		}
	}
}

// TestIssueSearchGuards 钉三条「不能静默成功」的输入：
//
//	· 不认识的 kind → 400（值域来自 issue_kinds，不是封闭枚举，但也不是「随便传」）；
//	· q 里的 LIKE 通配符 → 400（不转义的话 % 会命中全部，看起来像搜索生效了）；
//	· q 超长 → 400（防止拿一个超长串当扫表工具）。
func TestIssueSearchGuards(t *testing.T) {
	h := newHarness(t)
	_, t1 := h.setupTopic(t)
	_ = t1
	_, err := h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Kind: "no_such_kind"})
	assertCode(t, err, "common.invalid_input")
	_, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Q: "%"})
	assertCode(t, err, "common.invalid_input")
	_, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Q: string(make([]rune, 101))})
	assertCode(t, err, "common.invalid_input")
	_, err = h.svc.ListIssues(h.ctx, nil, ListIssuesInput{Sort: "hottest"})
	assertCode(t, err, "common.invalid_input")
}
