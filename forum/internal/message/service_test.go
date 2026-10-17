package message

import (
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
)

// 盲审 B3 的回归：A 发给 B 的消息只能算 B 的未读，绝不能算 A 自己的。
func TestSendKeepsUnreadPerRecipient(t *testing.T) {
	f := newFixture(t, "alice", "bob")
	for i := 0; i < 3; i++ {
		msg, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "bob", Body: "hi"})
		if err != nil {
			t.Fatal(err)
		}
		if !msg.Mine || msg.Read {
			t.Fatalf("刚发出的消息应当 mine=true/read=false，实际 %+v", msg)
		}
	}
	if n, err := f.svc.UnreadTotal(f.ctx, f.actor("bob")); err != nil || n != 3 {
		t.Fatalf("B 的未读应为 3，实际 %d (err=%v)", n, err)
	}
	if n, err := f.svc.UnreadTotal(f.ctx, f.actor("alice")); err != nil || n != 0 {
		t.Fatalf("A 的未读必须为 0（自己发的不算自己未读），实际 %d (err=%v)", n, err)
	}

	// B 打开会话：只标「对方发给我的」未读
	n, err := f.svc.MarkThreadRead(f.ctx, f.actor("bob"), "alice")
	if err != nil || n != 3 {
		t.Fatalf("标记已读应为 3 条，实际 %d (err=%v)", n, err)
	}
	if n, _ := f.svc.UnreadTotal(f.ctx, f.actor("bob")); n != 0 {
		t.Fatalf("B 的未读该清零，实际 %d", n)
	}
	if n, err := f.svc.MarkThreadRead(f.ctx, f.actor("bob"), "alice"); err != nil || n != 0 {
		t.Fatalf("重复标记该是 0 条（并发重放），实际 %d (err=%v)", n, err)
	}
	// 反过来：A 标已读不该动 B 读过的行（那 3 条是 A 发的，sender 不是我）
	if n, err := f.svc.MarkThreadRead(f.ctx, f.actor("alice"), "bob"); err != nil || n != 0 {
		t.Fatalf("A 标已读不该改任何行，实际 %d (err=%v)", n, err)
	}
	if n, _ := f.svc.UnreadTotal(f.ctx, f.actor("alice")); n != 0 {
		t.Fatalf("A 的未读仍应为 0，实际 %d", n)
	}
}

// d4 §8.2：会话列表的 unread_count 之和必须等于未读角标（两条 SQL 同一批谓词）。
func TestConversationUnreadMatchesUnreadTotal(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	for i := 0; i < 2; i++ {
		if _, err := f.svc.Send(f.ctx, f.actor("bob"), SendInput{PeerHandle: "alice", Body: "b1"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.Send(f.ctx, f.actor("carol"), SendInput{PeerHandle: "alice", Body: "c1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "carol", Body: "a1"}); err != nil {
		t.Fatal(err)
	}

	page, err := f.svc.ListConversations(f.ctx, f.actor("alice"), PageInput{})
	if err != nil {
		t.Fatal(err)
	}
	sum := 0
	for _, item := range page.Items {
		sum += item.UnreadCount
	}
	total, err := f.svc.UnreadTotal(f.ctx, f.actor("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if sum != total || total != 3 {
		t.Fatalf("会话未读之和 %d 必须等于角标 %d（都应为 3）", sum, total)
	}
	if len(page.Items) != 2 {
		t.Fatalf("应当有 2 个会话，实际 %d", len(page.Items))
	}
	// 最后一条必须是最新的那条
	for _, item := range page.Items {
		if item.Peer.Handle == "carol" && item.Last.Body != "a1" {
			t.Fatalf("carol 会话的最后一条应是 a1，实际 %q", item.Last.Body)
		}
	}
}

// 「各自删除」：我删掉的不返回，对方照常看得见；未读只按我这一侧的标记减。
func TestDeleteIsPerSide(t *testing.T) {
	f := newFixture(t, "alice", "bob")
	var ids []string
	for i := 0; i < 3; i++ {
		msg, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "bob", Body: "hi"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, msg.ID)
	}
	if err := f.svc.DeleteMessage(f.ctx, f.actor("alice"), ids[0]); err != nil {
		t.Fatal(err)
	}

	aThread, err := f.svc.ListThread(f.ctx, f.actor("alice"), ThreadInput{PeerHandle: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	if len(aThread.Items) != 2 {
		t.Fatalf("A 删掉的不该出现在 A 的会话里，实际 %d 条", len(aThread.Items))
	}
	bThread, err := f.svc.ListThread(f.ctx, f.actor("bob"), ThreadInput{PeerHandle: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	if len(bThread.Items) != 3 {
		t.Fatalf("B 仍该看得见 3 条，实际 %d", len(bThread.Items))
	}
	if n, _ := f.svc.UnreadTotal(f.ctx, f.actor("bob")); n != 3 {
		t.Fatalf("A 的删除不该影响 B 的未读，实际 %d", n)
	}

	// B 删掉一条**未读**：未读要减 1
	if err := f.svc.DeleteMessage(f.ctx, f.actor("bob"), ids[1]); err != nil {
		t.Fatal(err)
	}
	if n, _ := f.svc.UnreadTotal(f.ctx, f.actor("bob")); n != 2 {
		t.Fatalf("B 删掉一条未读后应剩 2，实际 %d", n)
	}

	// 双方都删：两边都看不到，行仍在（cron 才硬删）
	if err := f.svc.DeleteMessage(f.ctx, f.actor("alice"), ids[1]); err != nil {
		t.Fatal(err)
	}
	if n := countMessages(t, f.ctx, f.pool, "id = (SELECT id FROM messages WHERE public_id::text = $1)", ids[1]); n != 1 {
		t.Fatalf("双方都删之后行仍该在表里，实际 %d", n)
	}
	bThread, err = f.svc.ListThread(f.ctx, f.actor("bob"), ThreadInput{PeerHandle: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	if len(bThread.Items) != 2 {
		t.Fatalf("B 现在也不该看到那条，实际 %d", len(bThread.Items))
	}

	// 没参与这条会话的人 / 不存在的 id → 404（两者同一个响应，避免枚举）
	carol := newUser(t, f.ctx, f.pool, "carol")
	if err := f.svc.DeleteMessage(f.ctx, &authz.Actor{UserID: carol}, ids[2]); !isCode(err, apperr.CodeNotFound) {
		t.Fatalf("删自己没参与的消息必须 404，实际 %v", err)
	}
	if err := f.svc.DeleteMessage(f.ctx, f.actor("bob"), "not-a-uuid"); !isCode(err, apperr.CodeNotFound) {
		t.Fatalf("坏 id 必须 404，实际 %v", err)
	}
}

func TestSendValidation(t *testing.T) {
	f := newFixture(t, "alice", "bob")

	if _, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "alice", Body: "hi"}); !isCode(err, apperr.CodeInvalidInput) {
		t.Fatalf("给自己发必须 400，实际 %v", err)
	}
	if _, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "nobody", Body: "hi"}); !isCode(err, apperr.CodeNotFound) {
		t.Fatalf("不存在的 handle 必须 404，实际 %v", err)
	}
	if _, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "bob", Body: "   "}); !isCode(err, apperr.CodeInvalidInput) {
		t.Fatalf("空 body 必须 400，实际 %v", err)
	}
	if _, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "bob", Body: runes(2001)}); !isCode(err, apperr.CodeInvalidInput) {
		t.Fatalf("2001 字必须 400，实际 %v", err)
	}
	if _, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "bob", Body: runes(2000)}); err != nil {
		t.Fatalf("正好 2000 字必须成功，实际 %v", err)
	}
	// 前后空白被 trim 掉后落库
	msg, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "bob", Body: "  hi  "})
	if err != nil {
		t.Fatal(err)
	}
	if msg.Body != "hi" {
		t.Fatalf("body 该 trim 后落库，实际 %q", msg.Body)
	}
}

func TestSendBlockedEitherDirection(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	f.blocks.blocked[[2]int64{f.users["alice"], f.users["bob"]}] = true

	if _, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "bob", Body: "hi"}); !isCode(err, CodeBlocked) {
		t.Fatalf("我拉黑了对方也必须发不出去，实际 %v", err)
	}
	if _, err := f.svc.Send(f.ctx, f.actor("bob"), SendInput{PeerHandle: "alice", Body: "hi"}); !isCode(err, CodeBlocked) {
		t.Fatalf("被拉黑必须发不出去，实际 %v", err)
	}
	if _, err := f.svc.Send(f.ctx, f.actor("carol"), SendInput{PeerHandle: "alice", Body: "hi"}); err != nil {
		t.Fatalf("与拉黑无关的人必须照常发，实际 %v", err)
	}
}

func TestThreadPagingAndConversationCursor(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	// 会话内翻页：25 条
	for i := 0; i < 25; i++ {
		if _, err := f.svc.Send(f.ctx, f.actor("bob"), SendInput{PeerHandle: "alice", Body: "m"}); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	cursor := ""
	for page := 0; ; page++ {
		res, err := f.svc.ListThread(f.ctx, f.actor("alice"), ThreadInput{PeerHandle: "bob", Limit: 10, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range res.Items {
			if seen[m.ID] {
				t.Fatalf("会话内翻页出现重复 %s", m.ID)
			}
			seen[m.ID] = true
			if m.Mine {
				t.Fatalf("这些消息都是 bob 发的，mine 必须为 false")
			}
		}
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
		if page > 5 {
			t.Fatal("翻页没有终止")
		}
	}
	if len(seen) != 25 {
		t.Fatalf("应翻出 25 条，实际 %d", len(seen))
	}

	// 会话列表游标：三个会话
	if _, err := f.svc.Send(f.ctx, f.actor("carol"), SendInput{PeerHandle: "alice", Body: "c"}); err != nil {
		t.Fatal(err)
	}
	first, err := f.svc.ListConversations(f.ctx, f.actor("alice"), PageInput{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 1 || first.NextCursor == "" {
		t.Fatalf("limit=1 时该有一项且有下一页，实际 %d 项 / cursor=%q", len(first.Items), first.NextCursor)
	}
	second, err := f.svc.ListConversations(f.ctx, f.actor("alice"), PageInput{Limit: 1, Cursor: first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 {
		t.Fatalf("第二页该有一项，实际 %d", len(second.Items))
	}
	if second.Items[0].Peer.Handle == first.Items[0].Peer.Handle {
		t.Fatalf("两页返回了同一个会话 %s", second.Items[0].Peer.Handle)
	}
	if _, err := f.svc.ListConversations(f.ctx, f.actor("alice"), PageInput{Cursor: "xx"}); !isCode(err, apperr.CodeInvalidInput) {
		t.Fatalf("坏游标必须 400，实际 %v", err)
	}
	// 会话头的对方资料
	thread, err := f.svc.ListThread(f.ctx, f.actor("alice"), ThreadInput{PeerHandle: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	if thread.Peer.Handle != "bob" || thread.Peer.Nickname != "bob" {
		t.Fatalf("会话头该带对方资料，实际 %+v", thread.Peer)
	}
}

// 并发乱序发送：全部落库、规范化顺序由 CHECK 保证、会话列表最后一条是最大 id。
func TestConcurrentSendKeepsPairOrder(t *testing.T) {
	f := newFixture(t, "alice", "bob")
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			from, to := "alice", "bob"
			if i%2 == 1 {
				from, to = "bob", "alice"
			}
			if _, err := f.svc.Send(f.ctx, f.actor(from), SendInput{PeerHandle: to, Body: "x"}); err != nil {
				t.Errorf("send: %v", err)
			}
		}(i)
	}
	wg.Wait()

	if n := countMessages(t, f.ctx, f.pool, ""); n != 20 {
		t.Fatalf("20 条并发发送都该落库，实际 %d", n)
	}
	bad := countMessages(t, f.ctx, f.pool, "low_id >= high_id")
	if bad != 0 {
		t.Fatalf("有 %d 行的规范化顺序被破坏（low_id < high_id 是 CHECK）", bad)
	}
	page, err := f.svc.ListConversations(f.ctx, f.actor("alice"), PageInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("只有一个会话，实际 %d", len(page.Items))
	}
	var maxID int64
	if err := f.pool.QueryRow(f.ctx, "SELECT max(id) FROM messages").Scan(&maxID); err != nil {
		t.Fatal(err)
	}
	var lastPublic string
	if err := f.pool.QueryRow(f.ctx, "SELECT public_id::text FROM messages WHERE id = $1", maxID).Scan(&lastPublic); err != nil {
		t.Fatal(err)
	}
	if page.Items[0].Last.ID != lastPublic {
		t.Fatalf("会话列表的最后一条该是最大 id 那条，实际 %s != %s", page.Items[0].Last.ID, lastPublic)
	}
}

func TestPurgeOnlyRemovesBothDeletedAndExpired(t *testing.T) {
	f := newFixture(t, "alice", "bob")
	var ids []string
	for i := 0; i < 3; i++ {
		msg, err := f.svc.Send(f.ctx, f.actor("alice"), SendInput{PeerHandle: "bob", Body: "hi"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, msg.ID)
	}
	// 第 1 条：双方都删；第 2 条：只有 A 删；第 3 条：没人删
	for _, who := range []string{"alice", "bob"} {
		if err := f.svc.DeleteMessage(f.ctx, f.actor(who), ids[0]); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.svc.DeleteMessage(f.ctx, f.actor("alice"), ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, "UPDATE messages SET created_at = now() - interval '100 days'"); err != nil {
		t.Fatal(err)
	}

	n, err := f.svc.Purge(f.ctx, clock.Real{}.Now().Add(-90*24*time.Hour), 5000)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("只该硬删「双方都删」那条，实际 %d", n)
	}
	if c := countMessages(t, f.ctx, f.pool, ""); c != 2 {
		t.Fatalf("另外两条必须留下，实际 %d", c)
	}
}

func TestRegisterRoutesDoNotConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	h := NewHandler(nil, func(*gin.Context) (*authz.Actor, bool) { return &authz.Actor{UserID: 1}, true })
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("注册路由 panic（静态段与 /:handle 冲突）: %v", r)
			}
		}()
		h.Register(engine.Group("/api/v1"), noop)
	}()
	got := map[string]bool{}
	for _, rt := range engine.Routes() {
		got[rt.Method+" "+rt.Path] = true
	}
	for _, want := range []string{
		"GET /api/v1/messages",
		"GET /api/v1/messages/unread-count",
		"GET /api/v1/messages/:handle",
		"POST /api/v1/messages/:handle",
		"POST /api/v1/messages/:handle/read",
		"DELETE /api/v1/messages/:id",
	} {
		if !got[want] {
			t.Fatalf("缺少路由 %s（实际 %v）", want, got)
		}
	}
}
