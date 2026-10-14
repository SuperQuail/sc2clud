package forum

import (
	"fmt"
	"testing"
	"time"

	"forum/internal/authz"
)

// L2（拍板 08）：最热排序 score = (like_count + 3 * 顶层评论数) * time_boost。
//
// 口径三条（用户原话）：
//
//	· 「按点赞与评论数据加权」   → 两个分量都在 score 里；
//	· 「等效一个评论等于三个点赞」→ 评论的系数是 3；
//	· 「评论不计算楼中楼」        → **顶层**评论才算；
//	· 「一周内的互动有 1.5 倍数增益」→ time_boost 由 last_interaction_at 判。
//
// 这条用例的判据必须**只**由这个加权公式满足：任何一个分量算错、系数写成 1、
// 或者拿 topics.reply_count（含楼中楼，J4 的口径）当乘数，下面的顺序都会变。
func TestHotSortWeightsCommentsThreeTimesLikes(t *testing.T) {
	h := newHarness(t)
	// 时钟对齐真实 now()：SQL 里的「一周内」用的是库的 now()，而测试台的假时钟默认
	// 停在 2026-10-13 —— 两者差一天以上时「一周内」的档位会自己变（迁移 0025 的陷阱）。
	h.clk.T = time.Now().UTC()
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	h.seedBoard("general", 0, false)

	// 三条帖，刻意让「点赞多的」与「评论多的」不是同一条：
	//   manyLikes：20 赞 0 评论 → 20
	//   manyReplies：1 赞 7 顶层评论 → 1 + 21 = 22（评论 3 倍）
	//   quiet：3 赞 0 评论 → 3
	manyLikes := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "点赞多", ContentMD: "x"})
	manyReplies := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "评论多", ContentMD: "x"})
	quiet := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "安静", ContentMD: "x"})

	for i := 0; i < 20; i++ {
		liker, _ := h.author(fmt.Sprintf("liker%d", i), 5, true, "")
		if _, err := h.svc.Vote(h.ctx, liker, VoteTopic, manyLikes.ID, 1); err != nil {
			t.Fatalf("点赞失败: %v", err)
		}
	}
	for i := 0; i < 3; i++ {
		liker, _ := h.author(fmt.Sprintf("qliker%d", i), 5, true, "")
		if _, err := h.svc.Vote(h.ctx, liker, VoteTopic, quiet.ID, 1); err != nil {
			t.Fatalf("点赞失败: %v", err)
		}
	}
	if _, err := h.svc.Vote(h.ctx, author, VoteTopic, manyReplies.ID, 1); err != nil {
		t.Fatalf("点赞失败: %v", err)
	}
	// 7 条顶层评论 + 5 条楼中楼：楼中楼**不算**（口径），所以 manyReplies 的评论分量是 21。
	var tops []string
	for i := 0; i < 7; i++ {
		p, err := h.svc.CreatePost(h.ctx, author, manyReplies.ID, CreatePostInput{ContentMD: "顶层"})
		if err != nil {
			t.Fatalf("发顶层回复失败: %v", err)
		}
		tops = append(tops, p.ID)
	}
	for i := 0; i < 5; i++ {
		if _, err := h.svc.CreatePost(h.ctx, author, manyReplies.ID, CreatePostInput{ContentMD: "楼中楼", ParentID: tops[0]}); err != nil {
			t.Fatalf("发楼中楼失败: %v", err)
		}
	}

	page, err := h.svc.ListTopics(h.ctx, author, ListTopicsInput{Sort: "hot"})
	if err != nil {
		t.Fatalf("sort=hot 失败: %v", err)
	}
	got := make([]string, 0, len(page.Items))
	for _, it := range page.Items {
		got = append(got, it.Title)
	}
	// 22 > 20 > 3：评论多的排第一。若把楼中楼也算进评论分量，manyReplies 会是 1+3*12=37，
	// 顺序一样 —— 所以楼中楼那一条要靠 TestHotSortCountsOnlyTopLevelComments 单独钉。
	want := []string{"评论多", "点赞多", "安静"}
	if len(got) != len(want) {
		t.Fatalf("应有 %d 条，实际 %d：%v", len(want), len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("最热顺序应为 %v，实际 %v", want, got)
		}
	}
	_ = quiet
}

// TestHotSortCountsOnlyTopLevelComments 单独钉「不计算楼中楼」这一条（用户原话）：
// 两条帖的**顶层**评论数不同、总回复数相同 —— 拿 reply_count（含楼中楼）当乘数会让它们并列。
func TestHotSortCountsOnlyTopLevelComments(t *testing.T) {
	h := newHarness(t)
	h.clk.T = time.Now().UTC()
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	h.seedBoard("general", 0, false)

	// fewTop：2 条顶层 + 8 条楼中楼 → 顶层 2；reply_count 会显示 10
	// manyTop：6 条顶层 + 0 条楼中楼 → 顶层 6；reply_count 也是 6
	// 结论：manyTop 必须排在前面（6*3=18 > 2*3=6），而按 reply_count 排会得到相反的顺序。
	fewTop := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "楼中楼多", ContentMD: "x"})
	manyTop := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "顶层多", ContentMD: "x"})
	var parents []string
	for i := 0; i < 2; i++ {
		p, err := h.svc.CreatePost(h.ctx, author, fewTop.ID, CreatePostInput{ContentMD: "顶层"})
		if err != nil {
			t.Fatal(err)
		}
		parents = append(parents, p.ID)
	}
	for i := 0; i < 8; i++ {
		if _, err := h.svc.CreatePost(h.ctx, author, fewTop.ID, CreatePostInput{ContentMD: "楼中楼", ParentID: parents[0]}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 6; i++ {
		if _, err := h.svc.CreatePost(h.ctx, author, manyTop.ID, CreatePostInput{ContentMD: "顶层"}); err != nil {
			t.Fatal(err)
		}
	}

	page, err := h.svc.ListTopics(h.ctx, author, ListTopicsInput{Sort: "hot"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("应有 2 条，实际 %d", len(page.Items))
	}
	if page.Items[0].Title != "顶层多" {
		t.Fatalf("楼中楼不该算热度：第一条应是「顶层多」，实际 %v/%v", page.Items[0].Title, page.Items[1].Title)
	}
	// 顺带证明两条帖的 reply_count **确实**是反的（10 vs 6）：拿它当乘数就会排错。
	var rcFew, rcMany int
	if err := h.pool.QueryRow(h.ctx, "SELECT reply_count FROM topics WHERE public_id = $1", fewTop.ID).Scan(&rcFew); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(h.ctx, "SELECT reply_count FROM topics WHERE public_id = $1", manyTop.ID).Scan(&rcMany); err != nil {
		t.Fatal(err)
	}
	if !(rcFew > rcMany) {
		t.Fatalf("前提不成立：含楼中楼的 reply_count 应当是一条大一条小，实际 %d vs %d", rcFew, rcMany)
	}
}

// TestHotSortGivesRecentInteractionAOneAndAHalfBoost 钉 1.5 倍的时间增益。
//
// 两条帖的互动量**完全相同**，只差互动时间：一条在 30 天前，一条在刚刚。
// 没有增益时两者同分（并列，靠 id 兜底）；有增益时近的那条分数 1.5 倍 → 必须排前面。
func TestHotSortGivesRecentInteractionAOneAndAHalfBoost(t *testing.T) {
	h := newHarness(t)
	h.clk.T = time.Now().UTC()
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	h.seedBoard("general", 0, false)

	old := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "老互动", ContentMD: "x"})
	recent := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "新互动", ContentMD: "x"})

	// 两条各 4 赞（互动量相同）
	for i := 0; i < 4; i++ {
		liker, _ := h.author(fmt.Sprintf("liker%d", i), 5, true, "")
		if _, err := h.svc.Vote(h.ctx, liker, VoteTopic, old.ID, 1); err != nil {
			t.Fatal(err)
		}
		if _, err := h.svc.Vote(h.ctx, liker, VoteTopic, recent.ID, 1); err != nil {
			t.Fatal(err)
		}
	}
	// 把「老互动」那条的互动时间推到 30 天前（直接改冗余列：它是本域唯一的互动时间真源）
	if _, err := h.pool.Exec(h.ctx,
		"UPDATE topics SET last_interaction_at = now() - interval '30 days' WHERE public_id = $1", old.ID); err != nil {
		t.Fatal(err)
	}

	page, err := h.svc.ListTopics(h.ctx, author, ListTopicsInput{Sort: "hot"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("应有 2 条，实际 %d", len(page.Items))
	}
	if page.Items[0].Title != "新互动" {
		t.Fatalf("一周内的互动应有 1.5 倍增益，第一条应是「新互动」，实际 %v", page.Items[0].Title)
	}
}

// TestHotSortCursorPagesWithoutGapsOrDupes 钉游标：最热的键不是时间，编码与判定都换了一套
// （见 forum/cursor.go 的 hotCursor 与 pgsql 的 hotScoreSQL）。
//
// 判据是「两页拼起来恰好是全部、没有重复」（§3.8 规则 1/3）——
// 只断言「第二页非空」证明不了游标编码对，因为错的条件也可能返回一个非空集合。
func TestHotSortCursorPagesWithoutGapsOrDupes(t *testing.T) {
	h := newHarness(t)
	h.clk.T = time.Now().UTC()
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	h.seedBoard("general", 0, false)

	const n = 10
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		d := h.mustTopic(author, CreateTopicInput{
			BoardSlug: "general", Title: fmt.Sprintf("帖%02d", i), ContentMD: "x",
		})
		ids = append(ids, d.ID)
	}
	// 每条帖**同一个分数**（都是 1 赞、零评论、同一时刻的互动）：这就是游标第二段 (score,id)
	// 存在的理由 —— 只比分数会漏行或重行，必须再比 id。
	for i := 0; i < n; i++ {
		liker, _ := h.author(fmt.Sprintf("liker%d", i), 5, true, "")
		if _, err := h.svc.Vote(h.ctx, liker, VoteTopic, ids[i], 1); err != nil {
			t.Fatalf("点赞失败: %v", err)
		}
	}

	// limit=5、共 10 条：第一页 5 条 + 游标；第二页 5 条 + **游标（正好取满，按 §3.8 规则 3 仍给）**；
	// 第三页空。后两页是游标正确性的判据：第二页不能与第一页重叠，第三页必须是空集。
	seen := map[string]int{}
	pages := [][]string{}
	cursor := ""
	for page := 0; page < 4; page++ {
		p, err := h.svc.ListTopics(h.ctx, author, ListTopicsInput{Sort: "hot", Limit: 5, Cursor: cursor})
		if err != nil {
			t.Fatalf("第 %d 页失败: %v", page, err)
		}
		pageIDs := make([]string, 0, len(p.Items))
		for _, it := range p.Items {
			seen[it.ID]++
			pageIDs = append(pageIDs, it.ID)
		}
		pages = append(pages, pageIDs)
		if p.NextCursor == "" {
			break
		}
		cursor = p.NextCursor
	}
	if len(seen) != n {
		t.Fatalf("游标翻页应覆盖全部 %d 条，实际 %d 条（每页 %v）", n, len(seen), pages)
	}
	for id, c := range seen {
		if c != 1 {
			t.Fatalf("主题 %s 出现了 %d 次（游标重复）", id, c)
		}
	}
	if len(pages) < 3 || len(pages[2]) != 0 {
		t.Fatalf("取满的最后一页之后还应当有一个空页，实际各页为 %v", pages)
	}
}

// TestInvalidHotSortIsRejected 钉值域：sort 传别的值 → 400，不静默当 latest。
func TestInvalidHotSortIsRejected(t *testing.T) {
	h := newHarness(t)
	_, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{Sort: "hottest"})
	assertCode(t, err, "common.invalid_input")
}
