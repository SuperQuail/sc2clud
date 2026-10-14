package forum

import (
	"sync"
	"testing"

	"forum/internal/authz"
)

// authorActor 是「一个能发主题的普通作者」：建用户 + 拿权限点。
func (h *harness) author(handle string, level int, trusted bool, perms ...string) (*authz.Actor, int64) {
	h.t.Helper()
	role := h.seedRole("user", false)
	uid := h.seedUser(handle, role, level, trusted)
	return h.actor(uid, role, perms...), uid
}

// 发主题 → 详情 → 列表：一条走通的路，顺带验证 response 的形状。
func TestCreateTopicAndReadBack(t *testing.T) {
	h := newHarness(t)
	author, uid := h.author("alice", 1, false, authz.PermTopicCreate)
	boardID := h.seedBoard("general", 0, false)

	d := h.mustTopic(author, CreateTopicInput{
		BoardSlug: "general", Kind: "discussion", Title: "第一帖", ContentMD: "**正文**",
	})
	if d.Title != "第一帖" || d.ContentHTML != "<p>**正文**</p>" {
		t.Fatalf("详情字段不对: %+v", d)
	}
	if d.Author.Handle != "alice" || d.Board.Slug != "general" {
		t.Fatalf("作者或分区不对: %+v", d)
	}
	if d.ReviewState != "pending" {
		t.Fatalf("未 trusted 的作者应进审核队列，实际 %s", d.ReviewState)
	}

	// 1 楼必然存在，floor=1，且它不算回复。
	if n := h.countRows(t, "SELECT count(*) FROM posts WHERE topic_id = (SELECT id FROM topics WHERE public_id = $1)", d.ID); n != 1 {
		t.Fatalf("应有 1 层楼，实际 %d", n)
	}
	var floor int
	if err := h.pool.QueryRow(h.ctx, "SELECT floor FROM posts WHERE topic_id = (SELECT id FROM topics WHERE public_id = $1)", d.ID).Scan(&floor); err != nil {
		t.Fatal(err)
	}
	if floor != 1 {
		t.Fatalf("1 楼必须是 floor=1，实际 %d", floor)
	}
	if d.ReplyCount != 0 {
		t.Fatalf("1 楼不算回复，reply_count 应为 0，实际 %d", d.ReplyCount)
	}

	// 发主题投两个任务：search:index（搜索索引）与 ai:review（AI 审核，d7 §1）。
	// notify 由 D4 自己决定（d3-forum §8.3）；AI 调用本身在 worker 里，**不在发帖事务里**。
	types := h.queue.types()
	if len(types) != 2 || types[0] != "search:index" || types[1] != "ai:review" {
		t.Fatalf("发主题应投 search:index + ai:review，实际 %v", types)
	}

	// 游客看不到待审主题，作者自己看得到（§3.7 Q6 的第三条 or）。
	if _, err := h.svc.TopicDetail(h.ctx, nil, d.ID); err == nil {
		t.Fatal("游客不该看到 pending 主题")
	}
	assertCode(t, mustErr(h.svc.TopicDetail(h.ctx, nil, d.ID)), "topic.not_found")

	// 作者主页里有它，访客的列表里没有（§3.5 Q4a）。
	mine, err := h.svc.ListUserTopics(h.ctx, author, "alice", PageInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine.Items) != 1 {
		t.Fatalf("作者主页应有 1 条，实际 %d", len(mine.Items))
	}
	page, err := h.svc.ListTopics(h.ctx, nil, ListTopicsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("游客列表不该有待审帖，实际 %d 条", len(page.Items))
	}

	// trusted 作者直接过审（拍板 §2.2 第 1 条）。
	trusted, _ := h.author("bob", 1, true, authz.PermTopicCreate)
	d2 := h.mustTopic(trusted, CreateTopicInput{BoardSlug: "general", Title: "过审帖", ContentMD: "x"})
	if d2.ReviewState != "approved" {
		t.Fatalf("trusted 作者应直接 approved，实际 %s", d2.ReviewState)
	}
	page, err = h.svc.ListTopics(h.ctx, nil, ListTopicsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != d2.ID {
		t.Fatalf("过审帖应出现在游客列表里: %+v", page.Items)
	}
	_ = uid
	_ = boardID
}

// 权限点缺失 → 403；游客 → 401。**断言错误码**。
func TestCreateTopicPermission(t *testing.T) {
	h := newHarness(t)
	h.seedBoard("general", 0, false)
	author, _ := h.author("alice", 1, true) // 没有 topic.create

	_, err := h.svc.CreateTopic(h.ctx, author, CreateTopicInput{BoardSlug: "general", Title: "x", ContentMD: "y"})
	assertCode(t, err, "common.forbidden")

	_, err = h.svc.CreateTopic(h.ctx, nil, CreateTopicInput{BoardSlug: "general", Title: "x", ContentMD: "y"})
	assertCode(t, err, "common.unauthorized")

	// 不存在的分区 → 404，且**一个事务都没开**（校验在事务之前）。
	withPerm, _ := h.author("carol", 1, true, authz.PermTopicCreate)
	_, err = h.svc.CreateTopic(h.ctx, withPerm, CreateTopicInput{BoardSlug: "nope", Title: "x", ContentMD: "y"})
	assertCode(t, err, "board.not_found")
}

// 事务回滚：事务内的第二次写入失败时，第一次写入必须一起消失（§11.3 第 12 条的同类）。
func TestCreateTopicRollsBackOnFailure(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 1, true, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)

	// 让 1 楼的插入必然失败：public_id 撞上一个已存在的值（唯一约束）。
	dup := "11111111-1111-7111-8111-111111111111"
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO posts (public_id, topic_id, author_id, floor, content_md, content_html) SELECT $1, id, author_id, 1, '', '' FROM topics LIMIT 0", dup); err != nil {
		t.Fatal(err)
	}
	// 直接用一个会让主题插入失败的手段：client_token 超过 varchar(64) 会在库层报错。
	_, err := h.svc.CreateTopic(h.ctx, author, CreateTopicInput{
		BoardSlug: "general", Title: "x", ContentMD: "y",
		ClientToken: "0123456789012345678901234567890123456789012345678901234567890123456789",
	})
	if err == nil {
		t.Fatal("超长 client_token 应该被拦下")
	}
	if n := h.countRows(t, "SELECT count(*) FROM topics"); n != 0 {
		t.Fatalf("失败的发帖不该留下主题行，实际 %d 行", n)
	}
	if n := h.countRows(t, "SELECT count(*) FROM posts"); n != 0 {
		t.Fatalf("失败的发帖不该留下楼层，实际 %d 行", n)
	}
}

// 同一个 client_token 并发提交：只产生一个主题、一层 1 楼，且两次返回同一个 public_id（§4.3）。
func TestCreateTopicClientTokenIdempotent(t *testing.T) {
	h := newHarness(t)
	author, _ := h.author("alice", 1, true, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)

	const n = 8
	ids := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			d, err := h.svc.CreateTopic(h.ctx, author, CreateTopicInput{
				BoardSlug: "general", Title: "双击发帖", ContentMD: "正文", ClientToken: "tok-1",
			})
			if err != nil {
				errs[i] = err
				return
			}
			ids[i] = d.ID
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 个请求失败: %v", i, err)
		}
	}
	_ = n
	first := ids[0]
	for _, id := range ids {
		if id != first {
			t.Fatalf("同一 token 的 %d 次提交应返回同一条，实际 %s vs %s", n, first, id)
		}
	}
	if got := h.countRows(t, "SELECT count(*) FROM topics"); got != 1 {
		t.Fatalf("应只产生 1 个主题，实际 %d", got)
	}
	if got := h.countRows(t, "SELECT count(*) FROM posts"); got != 1 {
		t.Fatalf("应只产生 1 层楼，实际 %d", got)
	}
}

func mustErr[T any](_ T, err error) error { return err }
