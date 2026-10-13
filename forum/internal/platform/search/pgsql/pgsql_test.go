package pgsql

import (
	"fmt"
	"testing"

	"forum/internal/ent"
	"forum/internal/platform/search"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// d5 §6.9 ②：写入侧与查询侧必须是同一个 Tokenize。写库后逐字节比对，再验查询能命中。
func TestTokensWrittenMatchTokenize(t *testing.T) {
	ctx, client, pool := newTestDB(t)
	uid := newUser(t, ctx, pool)
	bid := newBoard(t, ctx, pool, "general")
	id := newTopic(t, ctx, pool, bid, uid, "大吉大利整合包", "normal", "approved")

	s := New(client)
	title, body := "大吉大利整合包", "这是第一章的说明"
	want := index(t, ctx, s, id, title, body)

	var got string
	if err := pool.QueryRow(ctx, "SELECT tokens FROM topic_search WHERE topic_id = $1", id).Scan(&got); err != nil {
		t.Fatalf("读回 tokens: %v", err)
	}
	if got != want {
		t.Fatalf("写入侧与查询侧分词不一致: got %q want %q", got, want)
	}
	if got != search.Tokenize(title+" "+body) {
		t.Fatalf("tokens 不是 Tokenize(title + ' ' + body_text): %q", got)
	}

	page, err := s.SearchTopics(ctx, search.Query{Tokens: search.Tokenize("大吉"), Limit: 20})
	if err != nil {
		t.Fatalf("搜索: %v", err)
	}
	if len(page.Hits) != 1 || page.Hits[0].TopicID != id {
		t.Fatalf("两字查询必须命中，实际 %+v", page.Hits)
	}
	if page.Tier != search.TierExact {
		t.Fatalf("有精确结果时不许降级，实际档位 %q", page.Tier)
	}
}

// d5 §6.9 ③：四种输入，一条都不能少（最后一条是档 2 生效的唯一证据）。
func TestFourInputsTwoTiers(t *testing.T) {
	ctx, client, pool := newTestDB(t)
	uid := newUser(t, ctx, pool)
	bid := newBoard(t, ctx, pool, "general")
	s := New(client)

	hard := newTopic(t, ctx, pool, bid, uid, "第三章隐藏结局", "normal", "approved")
	index(t, ctx, s, hard, "第三章隐藏结局", "剧情讨论")
	pack := newTopic(t, ctx, pool, bid, uid, "大吉大利整合包", "normal", "approved")
	index(t, ctx, s, pack, "大吉大利整合包", "整合包说明")
	// 单字只出现在正文里：B 支（tokens）是单字命中的唯一来源（d5 §6.4）
	difficult := newTopic(t, ctx, pool, bid, uid, "第三章讨论", "normal", "approved")
	index(t, ctx, s, difficult, "第三章讨论", "这关很难")

	cases := []struct {
		q        string
		wantID   int64
		wantTier search.Tier
	}{
		{"难", difficult, search.TierExact}, // 单字：同一个 GIN，不是另一条路
		{"大吉", pack, search.TierExact},     // 两字：bigram
		{"隐藏结局", hard, search.TierExact},   // 长词整串：档 1 的 AND
		{"隐藏的结局", hard, search.TierLoose},  // 丢一个字：只能靠档 2 的 OR 兜
	}
	for _, c := range cases {
		page, err := s.SearchTopics(ctx, search.Query{Tokens: search.Tokenize(c.q), Limit: 20})
		if err != nil {
			t.Fatalf("搜索 %q: %v", c.q, err)
		}
		if len(page.Hits) == 0 || page.Hits[0].TopicID != c.wantID {
			t.Fatalf("查询 %q 必须命中 %d，实际 %+v", c.q, c.wantID, page.Hits)
		}
		if page.Tier != c.wantTier {
			t.Fatalf("查询 %q 走错档：期望 %s，实际 %s", c.q, c.wantTier, page.Tier)
		}
	}
}

// 档位谎报（tier 与游标不匹配）→ 游标作废，从第一页重来（宁可重复一页，也不给错序结果）。
func TestTierMismatchRestartsFromFirstPage(t *testing.T) {
	ctx, client, pool := newTestDB(t)
	uid := newUser(t, ctx, pool)
	bid := newBoard(t, ctx, pool, "general")
	s := New(client)
	for i := 0; i < 3; i++ {
		title := fmt.Sprintf("第三章隐藏结局 %d", i)
		id := newTopic(t, ctx, pool, bid, uid, title, "normal", "approved")
		index(t, ctx, s, id, title, "说明")
	}
	tokens := search.Tokenize("隐藏的结局")
	page, err := s.SearchTopics(ctx, search.Query{Tokens: tokens, Limit: 2})
	if err != nil {
		t.Fatalf("首页: %v", err)
	}
	if page.Tier != search.TierLoose || len(page.Hits) != 2 || page.NextCursorRank == nil {
		t.Fatalf("首页应当走档 2 且还有下一页: tier=%s hits=%d", page.Tier, len(page.Hits))
	}

	// 谎报成 exact 并带上档 2 的游标：游标必须作废，返回的是**第一页**（与上面那页逐条相同）
	restart, err := s.SearchTopics(ctx, search.Query{
		Tokens: tokens, Limit: 2, Tier: search.TierExact,
		CursorRank: page.NextCursorRank, CursorID: page.NextCursorID,
	})
	if err != nil {
		t.Fatalf("谎报档位: %v", err)
	}
	if restart.Tier != page.Tier || len(restart.Hits) != len(page.Hits) {
		t.Fatalf("档位对不上时必须从第一页重来: tier=%s hits=%d", restart.Tier, len(restart.Hits))
	}
	for i, h := range restart.Hits {
		if h.TopicID != page.Hits[i].TopicID {
			t.Fatalf("重来的第一页必须与首页逐条相同，第 %d 条不同", i)
		}
	}

	// 原样带回 tier 与游标 → 正常翻到第二页，且与第一页不重复
	rest, err := s.SearchTopics(ctx, search.Query{
		Tokens: tokens, Limit: 2, Tier: page.Tier,
		CursorRank: page.NextCursorRank, CursorID: page.NextCursorID,
	})
	if err != nil {
		t.Fatalf("正常翻页: %v", err)
	}
	if rest.Tier != search.TierLoose || len(rest.Hits) != 1 {
		t.Fatalf("第二页应当剩 1 条: tier=%s hits=%d", rest.Tier, len(rest.Hits))
	}
	for _, a := range page.Hits {
		for _, b := range rest.Hits {
			if a.TopicID == b.TopicID {
				t.Fatalf("第二页与第一页重复: %d", a.TopicID)
			}
		}
	}
}

// 可见性反例（d5 §6.9 ⑤）：不该被搜到的状态必须 0 行。
func TestSearchNeverLeaksHiddenOrPending(t *testing.T) {
	ctx, client, pool := newTestDB(t)
	uid := newUser(t, ctx, pool)
	bid := newBoard(t, ctx, pool, "general")
	s := New(client)
	q := search.Query{Tokens: search.Tokenize("大吉"), Limit: 20}

	cases := []struct {
		name        string
		visibility  string
		reviewState string
		indexed     bool
	}{
		{"隐藏", "hidden", "approved", true},
		{"已删", "deleted", "approved", true},
		{"待审", "normal", "pending", true},
		{"被拒", "normal", "rejected", true},
		{"索引行缺失（任务失败后软删）", "normal", "approved", false},
	}
	for _, c := range cases {
		id := newTopic(t, ctx, pool, bid, uid, "大吉大利整合包", c.visibility, c.reviewState)
		if c.indexed {
			index(t, ctx, s, id, "大吉大利整合包", "说明")
		}
		page, err := s.SearchTopics(ctx, q)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(page.Hits) != 0 {
			t.Fatalf("%s 的主题被搜到了（越权披露）: %+v", c.name, page.Hits)
		}
	}
}

// 能搜到的那一条：正常状态必须命中（否则上面那组反例是「因为坏了所以全 0」的假绿）。
func TestSearchFindsVisibleTopic(t *testing.T) {
	ctx, client, pool := newTestDB(t)
	uid := newUser(t, ctx, pool)
	bid := newBoard(t, ctx, pool, "general")
	s := New(client)
	id := newTopic(t, ctx, pool, bid, uid, "大吉大利整合包", "normal", "approved")
	index(t, ctx, s, id, "大吉大利整合包", "说明")
	page, err := s.SearchTopics(ctx, search.Query{Tokens: search.Tokenize("大吉"), Limit: 20})
	if err != nil {
		t.Fatalf("搜索: %v", err)
	}
	if len(page.Hits) != 1 || page.Hits[0].TopicID != id {
		t.Fatalf("可见主题必须被搜到: %+v", page.Hits)
	}
}

// 翻页：排序键 (rank DESC, id DESC) 的游标不许跨页重复或漏项。
func TestCursorPaging(t *testing.T) {
	ctx, client, pool := newTestDB(t)
	uid := newUser(t, ctx, pool)
	bid := newBoard(t, ctx, pool, "general")
	s := New(client)
	for i := 0; i < 5; i++ {
		title := fmt.Sprintf("大吉大利整合包 %d", i)
		id := newTopic(t, ctx, pool, bid, uid, title, "normal", "approved")
		index(t, ctx, s, id, title, "说明")
	}
	tokens := search.Tokenize("大吉")
	seen := map[int64]bool{}
	page, err := s.SearchTopics(ctx, search.Query{Tokens: tokens, Limit: 2})
	if err != nil {
		t.Fatalf("首页: %v", err)
	}
	for {
		for _, h := range page.Hits {
			if seen[h.TopicID] {
				t.Fatalf("游标翻页出现重复项: %d", h.TopicID)
			}
			seen[h.TopicID] = true
		}
		if page.NextCursorRank == nil {
			break
		}
		page, err = s.SearchTopics(ctx, search.Query{
			Tokens: tokens, Limit: 2, Tier: page.Tier,
			CursorRank: page.NextCursorRank, CursorID: page.NextCursorID,
		})
		if err != nil {
			t.Fatalf("翻页: %v", err)
		}
	}
	if len(seen) != 5 {
		t.Fatalf("游标翻页漏项：期望 5 条，实际 %d", len(seen))
	}
}

// 分区筛选走 ($2::bigint IS NULL OR t.board_id = $2)。
func TestBoardFilter(t *testing.T) {
	ctx, client, pool := newTestDB(t)
	uid := newUser(t, ctx, pool)
	b1 := newBoard(t, ctx, pool, "b1")
	b2 := newBoard(t, ctx, pool, "b2")
	s := New(client)
	id1 := newTopic(t, ctx, pool, b1, uid, "大吉大利", "normal", "approved")
	index(t, ctx, s, id1, "大吉大利", "一")
	id2 := newTopic(t, ctx, pool, b2, uid, "大吉大利", "normal", "approved")
	index(t, ctx, s, id2, "大吉大利", "二")

	page, err := s.SearchTopics(ctx, search.Query{Tokens: search.Tokenize("大吉"), BoardID: &b2, Limit: 20})
	if err != nil {
		t.Fatalf("带分区搜索: %v", err)
	}
	if len(page.Hits) != 1 || page.Hits[0].TopicID != id2 {
		t.Fatalf("分区筛选不对: %+v", page.Hits)
	}
}

// 幂等：同一主题重放三次只剩一行，tokens 逐字节相同（队列是至少一次投递）。
func TestUpsertTopicIdempotent(t *testing.T) {
	ctx, client, pool := newTestDB(t)
	uid := newUser(t, ctx, pool)
	bid := newBoard(t, ctx, pool, "general")
	id := newTopic(t, ctx, pool, bid, uid, "大吉大利", "normal", "approved")
	doc := search.TopicDoc{TopicID: id, Title: "大吉大利", BodyText: "说明", Tokens: search.Tokenize("大吉大利 说明")}
	s := New(client)
	for i := 0; i < 3; i++ {
		if err := s.UpsertTopic(ctx, doc); err != nil {
			t.Fatalf("第 %d 次写入: %v", i+1, err)
		}
	}
	var n int
	var tokens string
	if err := pool.QueryRow(ctx, "SELECT count(*), min(tokens) FROM topic_search WHERE topic_id = $1", id).Scan(&n, &tokens); err != nil {
		t.Fatalf("统计: %v", err)
	}
	if n != 1 || tokens != doc.Tokens {
		t.Fatalf("重放不幂等: 行数=%d tokens=%q", n, tokens)
	}
	if err := s.DeleteTopic(ctx, id); err != nil {
		t.Fatalf("删除: %v", err)
	}
	if err := s.DeleteTopic(ctx, id); err != nil {
		t.Fatalf("重复删除必须幂等: %v", err)
	}
}

// 编译期断言：Searcher 同时满足两个接口（handler 与 worker 各用一半）。
var (
	_ search.Searcher = (*Searcher)(nil)
	_ search.Indexer  = (*Searcher)(nil)
)

// ent 的 client 是 New 的入参类型，这里只做一次显式引用，省得 import 被当成多余。
var _ *ent.Client
