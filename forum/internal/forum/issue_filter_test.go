package forum

import (
	"testing"

	"forum/internal/authz"
)

// J6（拍板 08）：「Issue 类型不做成封闭枚举：值域由数据/配置驱动，当前四类，将来可增」。
//
// 用户原话：「可变,只是当前是四类,之后有可能增加」。
//
// 这条用例的判据是「**不改一行代码**就能多一类」：往 issue_kinds 插一行，服务不仅要收，
// 还要能拿它当筛选项。旧行为（Go 里的 switch + 0005 的 CHECK 枚举）在这条上必然红 ——
// 400 会先拦住创建，而且即使绕过去，CHECK 也会让 INSERT 失败。
func TestIssueKindIsDataDriven(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}

	// 基线：当前四类都在（值域表是这条迁移的唯一真源）
	kinds, err := h.svc.IssueKinds(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"bug", "feature", "difficulty", "other"} {
		found := false
		for _, k := range kinds {
			if k == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("当前四类缺 %s：%v", want, kinds)
		}
	}

	// ① 不认识的类型 → 400（不是静默放行）
	_, err = h.svc.CreateIssue(h.ctx, author, topic.ID, CreateIssueInput{Kind: "balance", Title: "x", BodyMD: "y"})
	assertCode(t, err, "common.invalid_input")

	// ② 加一类的全部动作 = INSERT 一行
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO issue_kinds (key, name, sort) VALUES ('balance', '平衡性', 9)"); err != nil {
		t.Fatalf("加一类不该需要改代码，插一行就行: %v", err)
	}
	created, err := h.svc.CreateIssue(h.ctx, author, topic.ID, CreateIssueInput{Kind: "balance", Title: "平衡性", BodyMD: "y"})
	if err != nil {
		t.Fatalf("新加的类型应当能直接用（数据驱动）: %v", err)
	}
	if created.Kind != "balance" {
		t.Fatalf("类型应当原样透传，实际 %s", created.Kind)
	}

	// ③ 新类型也能当筛选项（同一个值域）
	page, err := h.svc.ListIssues(h.ctx, author, ListIssuesInput{TopicPublicID: topic.ID, Kind: "balance"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != created.ID {
		t.Fatalf("按新类型筛选应命中那一条，实际 %d 条", len(page.Items))
	}

	// ④ archived 的类型不再接受新建（历史 Issue 仍然显示得出它）
	if _, err := h.pool.Exec(h.ctx, "UPDATE issue_kinds SET archived = true WHERE key = 'balance'"); err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.CreateIssue(h.ctx, author, topic.ID, CreateIssueInput{Kind: "balance", Title: "x", BodyMD: "y"})
	assertCode(t, err, "common.invalid_input")
}

// J8（拍板 08）：能关 Issue 的人 = 作者 / 版主 / 管理员及以上 / **Issue 发布者**。
//
// 四种人各一条断言。判据的分界很细：
//
//	· 「作者」= **主题**作者（这个帖子是我的，我关得掉别人提的反馈）；
//	· 「Issue 发布者」= 提这条反馈的人（哪怕主题不是他的）——**旧行为下这种人是 403**，
//	  因为当时只判主题归属；这一条就是本次改动的判据。
func TestWhoCanCloseAnIssue(t *testing.T) {
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}

	// reporter 是普通用户：能发 Issue（topic.create）但**没有** topic.lock、也不是主题作者
	reporter, _ := h.author("reporter", 1, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	issue, err := h.svc.CreateIssue(h.ctx, reporter, topic.ID, CreateIssueInput{Kind: "bug", Title: "卡关", BodyMD: "第三章"})
	if err != nil {
		t.Fatal(err)
	}

	closed := func(who *authz.Actor) error {
		return h.svc.UpdateIssue(h.ctx, who, issue.ID, UpdateIssueInput{Status: ptrStr("closed")})
	}
	// ① 旁观者：既不是主题作者也不是发布者，也没有 topic.lock → 403
	stranger, _ := h.author("stranger", 1, true, authz.PermTopicCreate)
	assertCode(t, closed(stranger), "common.forbidden")

	// ② Issue 发布者（不是主题作者）→ 能关。**旧行为这里 403**
	if err := closed(reporter); err != nil {
		t.Fatalf("Issue 发布者应当能关自己的反馈（J8）: %v", err)
	}
	// 再打开，好让后面的判定各自从 keep_open 出发
	if err := h.svc.UpdateIssue(h.ctx, reporter, issue.ID, UpdateIssueInput{Status: ptrStr("open")}); err != nil {
		t.Fatalf("Issue 发布者也应当能重新打开: %v", err)
	}

	// ③ 主题作者（不是 Issue 发布者）→ 能关
	if err := closed(author); err != nil {
		t.Fatalf("主题作者应当能关本主题下的 Issue: %v", err)
	}
	if err := h.svc.UpdateIssue(h.ctx, author, issue.ID, UpdateIssueInput{Status: ptrStr("open")}); err != nil {
		t.Fatal(err)
	}

	// ④ 分区版主（board.moderate + board_moderators 命中）→ 能关
	boardID := h.boardIDOf(t, "general")
	modRole := h.seedRole("creator-mod", false)
	modID := h.seedUser("moderator", modRole, 1, true)
	_, err = h.pool.Exec(h.ctx, "INSERT INTO board_moderators (board_id, user_id) VALUES ($1, $2)", boardID, modID)
	if err != nil {
		t.Fatal(err)
	}
	mod := h.actor(modID, modRole, authz.PermBoardModerate)
	mod.BoardIDs = []int64{boardID}
	if err := closed(mod); err != nil {
		t.Fatalf("版主应当能关本分区的 Issue: %v", err)
	}

	// ⑤ 管理员及以上（topic.lock 全局）→ 能关
	admin, _ := h.author("admin", 1, true, authz.PermTopicLock)
	if err := closed(admin); err != nil {
		t.Fatalf("持 topic.lock 的管理员应当能关: %v", err)
	}
}

// boardIDOf 按 slug 取分区内部 id（用例里要写 board_moderators）。
func (h *harness) boardIDOf(t *testing.T, slug string) int64 {
	t.Helper()
	var id int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM boards WHERE slug = $1", slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
