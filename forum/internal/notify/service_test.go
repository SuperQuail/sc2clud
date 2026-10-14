package notify

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/db"
	"forum/internal/platform/queue"
)

// isCode 判业务错误码（apperr 只给类型，没有 Is）。
func isCode(err error, code string) bool {
	var ae *apperr.Error
	return errors.As(err, &ae) && ae.Code == code
}

func itoa(v int64) string { return strconv.FormatInt(v, 10) }

// ---------- Create：幂等与事务 ----------

func TestCreateIsIdempotentByDedupKey(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")
	other := newUser(t, ctx, pool, "bob")

	in := CreateInput{UserID: u, ActorID: other, Kind: KindReply, RefType: RefPost, RefID: 42, TopicID: 7, Link: "/t/x"}
	for i := 0; i < 3; i++ {
		if err := db.WithTx(ctx, client, func(tx *ent.Tx) error { return svc.Create(ctx, tx, in) }); err != nil {
			t.Fatalf("第 %d 次 Create: %v", i+1, err)
		}
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", u); n != 1 {
		t.Fatalf("同一 dedup_key 只该有一行，实际 %d", n)
	}
	if n := countNotifications(t, ctx, pool, "dedup_key = 'reply:post:42'"); n != 1 {
		t.Fatal("dedup_key 应为 reply:post:42")
	}

	// 不同类别 = 不同 dedup_key：同一条帖子既能产生回复也能产生提及
	in.Kind = KindMention
	if err := db.WithTx(ctx, client, func(tx *ent.Tx) error { return svc.Create(ctx, tx, in) }); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", u); n != 2 {
		t.Fatalf("不同类别该各有一条，实际 %d", n)
	}
}

func TestCreateRollsBackWithBusinessTx(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")

	want := errors.New("业务失败")
	err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
		if err := svc.Create(ctx, tx, CreateInput{UserID: u, Kind: KindReply, RefType: RefPost, RefID: 1}); err != nil {
			return err
		}
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("错误必须原样返回，实际 %v", err)
	}
	if n := countNotifications(t, ctx, pool, ""); n != 0 {
		t.Fatalf("事务回滚后不该有通知，实际 %d 行", n)
	}
}

func TestCreateSystemNotificationKeepsTextAndSkipsDedup(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")

	for i := 0; i < 2; i++ {
		in := CreateInput{UserID: u, Kind: KindSystem, RefType: RefSystem, Text: "站点维护"}
		if err := db.WithTx(ctx, client, func(tx *ent.Tx) error { return svc.Create(ctx, tx, in) }); err != nil {
			t.Fatal(err)
		}
	}
	if n := countNotifications(t, ctx, pool, "type = 'system'"); n != 2 {
		t.Fatalf("系统通知没有「同一次事件」，不去重，实际 %d 行", n)
	}
	var payload string
	if err := pool.QueryRow(ctx, "SELECT payload::text FROM notifications LIMIT 1").Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, "站点维护") {
		t.Fatalf("text 必须进 payload，实际 %s", payload)
	}
}

// ---------- List / 未读 / 已读 ----------

func TestListPagesWithoutGapsOrDupesOnTies(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")

	// created_at 全部相同：排序只剩 id 兜底，这正是「游标必须带 id」要防的场景
	const total = 25
	for i := int64(1); i <= total; i++ {
		if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
			return svc.Create(ctx, tx, CreateInput{UserID: u, Kind: KindReply, RefType: RefPost, RefID: i})
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, "UPDATE notifications SET created_at = '2026-01-01T00:00:00Z'"); err != nil {
		t.Fatal(err)
	}

	seen := map[string]bool{}
	cursor := ""
	for page := 0; ; page++ {
		res, err := svc.List(ctx, actor(u), ListInput{Limit: 7, Cursor: cursor})
		if err != nil {
			t.Fatalf("第 %d 页: %v", page, err)
		}
		for _, item := range res.Items {
			if seen[item.ID] {
				t.Fatalf("游标分页出现重复项 %s", item.ID)
			}
			seen[item.ID] = true
		}
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
		if page > 10 {
			t.Fatal("翻页没有终止（游标没前进）")
		}
	}
	if len(seen) != total {
		t.Fatalf("翻完所有页应拿到 %d 条，实际 %d", total, len(seen))
	}

	if _, err := svc.List(ctx, actor(u), ListInput{Cursor: "not-base64"}); !isCode(err, apperr.CodeInvalidInput) {
		t.Fatalf("坏游标必须 400，实际 %v", err)
	}
}

func TestListFiltersAndHidesDeleted(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")
	other := newUser(t, ctx, pool, "bob")

	mk := func(kind string, refID int64) string {
		t.Helper()
		if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
			return svc.Create(ctx, tx, CreateInput{UserID: u, ActorID: other, Kind: kind, RefType: RefPost, RefID: refID, Link: "/t/a"})
		}); err != nil {
			t.Fatal(err)
		}
		var pub string
		if err := pool.QueryRow(ctx, "SELECT public_id::text FROM notifications WHERE user_id = $1 AND dedup_key = $2",
			u, DedupKey(kind, RefPost, refID)).Scan(&pub); err != nil {
			t.Fatal(err)
		}
		return pub
	}
	mk(KindReply, 1)
	mk(KindLike, 2)
	dead := mk(KindReply, 3)

	res, err := svc.List(ctx, actor(u), ListInput{Kind: KindLike})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].Kind != KindLike {
		t.Fatalf("?kind= 过滤失效: %+v", res.Items)
	}
	if res.Items[0].Actor == nil || res.Items[0].Actor.Handle != "bob" {
		t.Fatalf("actor 资料必须现取: %+v", res.Items[0].Actor)
	}

	if err := svc.Delete(ctx, actor(u), dead); err != nil {
		t.Fatal(err)
	}
	res, err = svc.List(ctx, actor(u), ListInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 2 {
		t.Fatalf("软删的行不该出现，实际 %d 条", len(res.Items))
	}
	// 软删不解除 dedup_key 占用：重放不会让它复活
	if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
		return svc.Create(ctx, tx, CreateInput{UserID: u, ActorID: other, Kind: KindReply, RefType: RefPost, RefID: 3, Link: "/t/a"})
	}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "deleted_at IS NOT NULL"); n != 1 {
		t.Fatalf("软删的行被重放复活了，实际 %d 行被删", n)
	}
}

func TestUnreadCountAndMarkRead(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")
	other := newUser(t, ctx, pool, "bob")

	var ids []string
	for i := int64(1); i <= 3; i++ {
		if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
			return svc.Create(ctx, tx, CreateInput{UserID: u, ActorID: other, Kind: KindReply, RefType: RefPost, RefID: i})
		}); err != nil {
			t.Fatal(err)
		}
		var pub string
		if err := pool.QueryRow(ctx, "SELECT public_id::text FROM notifications WHERE dedup_key = $1",
			DedupKey(KindReply, RefPost, i)).Scan(&pub); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, pub)
	}

	if n, err := svc.UnreadCount(ctx, actor(u)); err != nil || n != 3 {
		t.Fatalf("未读应为 3，实际 %d (err=%v)", n, err)
	}
	if n, err := svc.MarkRead(ctx, actor(u), MarkReadInput{PublicIDs: ids[:1]}); err != nil || n != 1 {
		t.Fatalf("标记 1 条应为 1，实际 %d (err=%v)", n, err)
	}
	if n, _ := svc.UnreadCount(ctx, actor(u)); n != 2 {
		t.Fatalf("未读应为 2，实际 %d", n)
	}
	if n, err := svc.MarkRead(ctx, actor(u), MarkReadInput{PublicIDs: ids[:1]}); err != nil || n != 0 {
		t.Fatalf("重复标记该是 0 行（并发重放），实际 %d (err=%v)", n, err)
	}
	if n, _ := svc.MarkRead(ctx, actor(u), MarkReadInput{All: true}); n != 2 {
		t.Fatalf("全部已读该标记 2 条，实际 %d", n)
	}
	if n, _ := svc.MarkRead(ctx, actor(u), MarkReadInput{All: true}); n != 0 {
		t.Fatalf("再次全部已读该是 0 条，实际 %d", n)
	}
	if n, _ := svc.UnreadCount(ctx, actor(u)); n != 0 {
		t.Fatalf("未读应清零，实际 %d", n)
	}

	// 别人的 id：0 行、不报 404、不改他人数据
	if n, err := svc.MarkRead(ctx, actor(other), MarkReadInput{PublicIDs: ids}); err != nil || n != 0 {
		t.Fatalf("标别人的通知应当是 0 行，实际 %d (err=%v)", n, err)
	}
	if _, err := svc.MarkRead(ctx, actor(u), MarkReadInput{}); !isCode(err, apperr.CodeInvalidInput) {
		t.Fatalf("空 ids 且 all=false 必须 400，实际 %v", err)
	}
	if _, err := svc.MarkRead(ctx, actor(u), MarkReadInput{PublicIDs: []string{"not-a-uuid"}}); !isCode(err, apperr.CodeInvalidInput) {
		t.Fatalf("坏 uuid 必须 400，实际 %v", err)
	}

	// 软删一条未读后角标要减：部分索引的谓词里必须有 deleted_at
	if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
		return svc.Create(ctx, tx, CreateInput{UserID: u, Kind: KindReply, RefType: RefPost, RefID: 9})
	}); err != nil {
		t.Fatal(err)
	}
	var ninth string
	if err := pool.QueryRow(ctx, "SELECT public_id::text FROM notifications WHERE dedup_key = $1",
		DedupKey(KindReply, RefPost, 9)).Scan(&ninth); err != nil {
		t.Fatal(err)
	}
	if n, _ := svc.UnreadCount(ctx, actor(u)); n != 1 {
		t.Fatalf("新通知该让未读回到 1，实际 %d", n)
	}
	if err := svc.Delete(ctx, actor(u), ninth); err != nil {
		t.Fatal(err)
	}
	if n, _ := svc.UnreadCount(ctx, actor(u)); n != 0 {
		t.Fatalf("软删未读后未读应为 0，实际 %d", n)
	}
}

func TestDeleteIsScopedAndIdempotent(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")
	other := newUser(t, ctx, pool, "bob")

	if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
		return svc.Create(ctx, tx, CreateInput{UserID: u, Kind: KindReply, RefType: RefPost, RefID: 1})
	}); err != nil {
		t.Fatal(err)
	}
	var pub string
	if err := pool.QueryRow(ctx, "SELECT public_id::text FROM notifications").Scan(&pub); err != nil {
		t.Fatal(err)
	}

	if err := svc.Delete(ctx, actor(other), pub); !isCode(err, apperr.CodeNotFound) {
		t.Fatalf("删别人的通知必须 404（不区分不存在），实际 %v", err)
	}
	if err := svc.Delete(ctx, actor(u), pub); err != nil {
		t.Fatal(err)
	}
	if err := svc.Delete(ctx, actor(u), pub); err != nil {
		t.Fatalf("重复删除必须幂等，实际 %v", err)
	}
	if err := svc.Delete(ctx, actor(u), "not-a-uuid"); !isCode(err, apperr.CodeNotFound) {
		t.Fatalf("坏 id 必须 404，实际 %v", err)
	}
}

// ---------- 静音 ----------

func TestMutesAreIdempotentAndFilterNotifications(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	alice := newUser(t, ctx, pool, "alice")
	bob := newUser(t, ctx, pool, "bob")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, alice)
	post := newPost(t, ctx, pool, topic, alice, nil)

	// 按类别静音 like
	if err := svc.SetMute(ctx, actor(alice), MuteInput{Type: KindLike}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetMute(ctx, actor(alice), MuteInput{Type: KindLike}); err != nil {
		t.Fatalf("重复静音必须幂等，实际 %v", err)
	}
	if err := svc.NotifyLike(ctx, CreateNotifyInput{ActorID: bob, RefType: RefPost, RefID: post}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "type = 'like'"); n != 0 {
		t.Fatalf("整类静音后不该产生 like 通知，实际 %d", n)
	}
	if err := svc.NotifyReply(ctx, CreateNotifyInput{ActorID: bob, RefType: RefPost, RefID: post}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "type = 'reply'"); n != 1 {
		t.Fatalf("回复不该被 like 静音影响，实际 %d", n)
	}

	if err := svc.UnsetMute(ctx, actor(alice), MuteInput{Type: KindLike}); err != nil {
		t.Fatal(err)
	}
	if err := svc.UnsetMute(ctx, actor(alice), MuteInput{Type: KindLike}); err != nil {
		t.Fatalf("取消不存在的静音必须幂等，实际 %v", err)
	}
	if err := svc.NotifyLike(ctx, CreateNotifyInput{ActorID: bob, RefType: RefPost, RefID: post}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "type = 'like'"); n != 1 {
		t.Fatalf("取消静音后该发出来，实际 %d", n)
	}

	// 按内容静音：这一条帖子的回复不发，别处照发
	other := newPost(t, ctx, pool, topic, alice, nil)
	if err := svc.SetMute(ctx, actor(alice), MuteInput{Type: KindLink, RefType: RefPost, RefID: other}); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyReply(ctx, CreateNotifyInput{ActorID: bob, RefType: RefPost, RefID: other}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "dedup_key = $1", DedupKey(KindReply, RefPost, other)); n != 0 {
		t.Fatalf("按内容静音后该帖的回复不该发，实际 %d", n)
	}

	for _, bad := range []MuteInput{
		{Type: "nonsense"},
		{Type: KindLike, RefType: RefPost, RefID: 1},
		{Type: KindLink},
		{Type: KindLink, RefType: "nonsense", RefID: 1},
	} {
		if err := svc.SetMute(ctx, actor(alice), bad); !isCode(err, apperr.CodeInvalidInput) {
			t.Fatalf("%+v 必须 400，实际 %v", bad, err)
		}
	}
}

// ---------- 任务入口 ----------

func TestNotifyReplyNotifiesTopicAndFloorAuthors(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	author := newUser(t, ctx, pool, "author")
	floor := newUser(t, ctx, pool, "floor")
	replier := newUser(t, ctx, pool, "replier")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)

	// 1 楼：楼层作者 == 主题作者 → 只发一条
	p1 := newPost(t, ctx, pool, topic, author, nil)
	if err := svc.NotifyReply(ctx, CreateNotifyInput{ActorID: replier, RefType: RefPost, RefID: p1, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", author); n != 1 {
		t.Fatalf("主题作者该收到一条，实际 %d", n)
	}

	// 楼中楼：父楼层作者 + 主题作者各一条
	p2 := newPost(t, ctx, pool, topic, floor, nil)
	p3 := newPost(t, ctx, pool, topic, replier, &p2)
	if err := svc.NotifyReply(ctx, CreateNotifyInput{ActorID: replier, RefType: RefPost, RefID: p3, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", floor); n != 1 {
		t.Fatalf("楼层作者该收到一条，实际 %d", n)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", author); n != 2 {
		t.Fatalf("主题作者该再收到一条，实际 %d", n)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", replier); n != 0 {
		t.Fatalf("自己回复自己不该有通知，实际 %d", n)
	}

	var link, payload string
	if err := pool.QueryRow(ctx, "SELECT link, payload::text FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1", author).
		Scan(&link, &payload); err != nil {
		t.Fatal(err)
	}
	if link != "/t/"+topicPublicID(t, ctx, pool, topic) {
		t.Fatalf("link 应为主题页，实际 %s", link)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(payload), &got); err != nil {
		t.Fatal(err)
	}
	if got["ref_type"] != RefPost || int64(got["ref_id"].(float64)) != p3 {
		t.Fatalf("payload 该带被回复的楼层 id，实际 %s", payload)
	}
}

func TestNotifyMentionHasDistinctDedupPerSource(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	author := newUser(t, ctx, pool, "author")
	mentioned := newUser(t, ctx, pool, "mentioned")
	actorUser := newUser(t, ctx, pool, "actor")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)
	post := newPost(t, ctx, pool, topic, author, nil)
	issue := newIssue(t, ctx, pool, topic, author)
	comment := newIssueComment(t, ctx, pool, issue, author)

	if err := svc.NotifyMention(ctx, CreateNotifyInput{ActorID: actorUser, RefType: RefPost, RefID: post, TopicID: topic, UserID: mentioned}); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyMention(ctx, CreateNotifyInput{ActorID: actorUser, RefType: RefComment, RefID: comment, TopicID: topic, UserID: mentioned}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", mentioned); n != 2 {
		t.Fatalf("帖子正文与 issue 评论是两个来源，该有两条，实际 %d", n)
	}
	if n := countNotifications(t, ctx, pool, "dedup_key = $1", "mention:comment:"+itoa(comment)); n != 1 {
		t.Fatal("issue 评论的提及 dedup_key 应为 mention:comment:<id>")
	}
	if err := svc.NotifyMention(ctx, CreateNotifyInput{ActorID: actorUser, RefType: RefPost, RefID: post, TopicID: topic, UserID: mentioned}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", mentioned); n != 2 {
		t.Fatalf("同一处重复提及不该多一条，实际 %d", n)
	}
	if err := svc.NotifyMention(ctx, CreateNotifyInput{ActorID: mentioned, RefType: RefPost, RefID: post, TopicID: topic, UserID: mentioned}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", mentioned); n != 2 {
		t.Fatalf("自己提自己不该有通知，实际 %d", n)
	}
}

func TestNotifyReplyAndMentionSameUserOnlyReplies(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	author := newUser(t, ctx, pool, "author")
	replier := newUser(t, ctx, pool, "replier")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)
	post := newPost(t, ctx, pool, topic, author, nil)

	// forum 会同时投 reply 与 mention 两个任务；被回复的人又被 @ 时只发 reply 一条（d4 §5.1）
	in := CreateNotifyInput{ActorID: replier, RefType: RefPost, RefID: post, TopicID: topic}
	if err := svc.NotifyReply(ctx, in); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyMention(ctx, CreateNotifyInput{ActorID: replier, RefType: RefPost, RefID: post, TopicID: topic, UserID: author}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", author); n != 1 {
		t.Fatalf("reply + @同一个人 只该有一条，实际 %d", n)
	}
	if n := countNotifications(t, ctx, pool, "type = 'reply'"); n != 1 {
		t.Fatalf("留下的那条必须是 reply，实际 reply=%d", n)
	}

	// 顺序反过来也一样（先 mention 后 reply）
	if _, err := pool.Exec(ctx, "DELETE FROM notifications"); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyMention(ctx, CreateNotifyInput{ActorID: replier, RefType: RefPost, RefID: post, TopicID: topic, UserID: author}); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyReply(ctx, in); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", author); n != 1 {
		t.Fatalf("反序也只该有一条，实际 %d", n)
	}
}

func TestNotifyLikeTargetsAuthorAndSkipsSelf(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	author := newUser(t, ctx, pool, "author")
	liker := newUser(t, ctx, pool, "liker")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)
	post := newPost(t, ctx, pool, topic, author, nil)

	if err := svc.NotifyLike(ctx, CreateNotifyInput{ActorID: liker, RefType: RefPost, RefID: post, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyLike(ctx, CreateNotifyInput{ActorID: liker, RefType: RefTopic, RefID: topic, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1 AND type = 'like'", author); n != 2 {
		t.Fatalf("帖子赞与主题赞各一条，实际 %d", n)
	}
	if err := svc.NotifyLike(ctx, CreateNotifyInput{ActorID: author, RefType: RefPost, RefID: post, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1 AND type = 'like'", author); n != 2 {
		t.Fatalf("自己赞自己不该有通知，实际 %d", n)
	}
	// 不认识的 ref_type：宁可让任务红，也不要静默丢
	if err := svc.NotifyLike(ctx, CreateNotifyInput{ActorID: liker, RefType: "nonsense", RefID: post}); err == nil {
		t.Fatal("未知 ref_type 必须报错")
	}
}

func TestNotifyIssueCommentLikeTargetsCommentAuthor(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	author := newUser(t, ctx, pool, "author")
	commenter := newUser(t, ctx, pool, "commenter")
	liker := newUser(t, ctx, pool, "liker")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)
	issue := newIssue(t, ctx, pool, topic, author)
	comment := newIssueComment(t, ctx, pool, issue, commenter)

	if err := svc.NotifyLike(ctx, CreateNotifyInput{ActorID: liker, RefType: RefComment, RefID: comment, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1 AND type = 'like'", commenter); n != 1 {
		t.Fatalf("issue 评论作者该收到赞的通知，实际 %d", n)
	}
}

func TestNotifyRewardReviewSanction(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	author := newUser(t, ctx, pool, "author")
	donor := newUser(t, ctx, pool, "donor")
	admin := newUser(t, ctx, pool, "admin")

	// 打赏：只有 approved 才发，金额现读
	pending := newDonation(t, ctx, pool, donor, author, "pending")
	if err := svc.NotifyReward(ctx, CreateNotifyInput{ActorID: donor, RefType: RefDonation, RefID: pending}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, ""); n != 0 {
		t.Fatalf("未核验的打赏不该发通知，实际 %d", n)
	}
	approved := newDonation(t, ctx, pool, donor, author, "approved")
	if err := svc.NotifyReward(ctx, CreateNotifyInput{ActorID: donor, RefType: RefDonation, RefID: approved}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "type = 'reward'"); n != 1 {
		t.Fatalf("核验通过该发一条，实际 %d", n)
	}
	var payload string
	if err := pool.QueryRow(ctx, "SELECT payload::text FROM notifications WHERE type = 'reward'").Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(payload), &got); err != nil {
		t.Fatal(err)
	}
	if got["amount_cents"].(float64) != 1234 {
		t.Fatalf("金额必须现读进 payload，实际 %v", got["amount_cents"])
	}

	// 审核：收件人是作者，触发者是 reviewed_by，state 与理由进 payload
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)
	if _, err := pool.Exec(ctx,
		"UPDATE topics SET review_state = 'rejected', review_note = '缺来源', reviewed_by = $2, reviewed_at = now() WHERE id = $1",
		topic, admin); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyReview(ctx, CreateNotifyInput{RefType: RefTopic, RefID: topic}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "type = 'review' AND user_id = $1 AND actor_id = $2", author, admin); n != 1 {
		t.Fatalf("审核结果该发给作者且带审核人，实际 %d", n)
	}

	// 处罚：收件人是被处罚的人
	victim := newUser(t, ctx, pool, "victim")
	until := clock.Real{}.Now().Add(24 * time.Hour)
	sanction := newSanction(t, ctx, pool, victim, admin, &until)
	if err := svc.NotifySanction(ctx, CreateNotifyInput{ActorID: admin, RefType: RefSanction, RefID: sanction}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "type = 'sanction' AND user_id = $1", victim); n != 1 {
		t.Fatalf("处罚该发给被处罚的人，实际 %d", n)
	}
	var sPayload string
	if err := pool.QueryRow(ctx, "SELECT payload::text FROM notifications WHERE type = 'sanction'").Scan(&sPayload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sPayload, "until") || !strings.Contains(sPayload, "刷屏") {
		t.Fatalf("处罚 payload 该带 until 与理由，实际 %s", sPayload)
	}
}

// 不带 ?kind= 时必须真的返回全部：parseListKinds 原来对空串返回**无类型 nil**，
// pgx 把它当 NULL 发出去，而 cardinality(NULL)=0 是 NULL、'x' = ANY(NULL) 也是 NULL ——
// 整个 WHERE 恒不成立，**通知列表永远空**（2026-10-14 实测：25 条翻页一条都拿不到）。
// 这条用例先红后绿：修在 parseListKinds（空串 → 空切片，而不是 nil）。
func TestListWithoutKindReturnsEverything(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")
	for i, kind := range []string{KindReply, KindLike, KindSystem} {
		in := CreateInput{UserID: u, Kind: kind, RefType: RefPost, RefID: int64(i + 1)}
		if kind == KindSystem {
			in = CreateInput{UserID: u, Kind: KindSystem, RefType: RefSystem, Text: "站点维护"}
		}
		if err := db.WithTx(ctx, client, func(tx *ent.Tx) error { return svc.Create(ctx, tx, in) }); err != nil {
			t.Fatal(err)
		}
	}
	res, err := svc.List(ctx, actor(u), ListInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 3 {
		t.Fatalf("不带 kind 时必须返回全部 3 条，实际 %d", len(res.Items))
	}
	// 带上 kind 仍然只过滤那一类（修 nil 不能把过滤也弄丢）
	res, err = svc.List(ctx, actor(u), ListInput{Kind: KindLike})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].Kind != KindLike {
		t.Fatalf("?kind=like 该只返回 1 条 like，实际 %+v", res.Items)
	}
}

// D4（交接单 M5）：通知是**消费时现读** topics，不是判定时快照。
// reject 紧接着 approve 时，两条 notify:review 任务都是后一个状态被读走 ——
// 「拒绝理由」一个字都送不到作者。修法：判定那一刻的 state/text 进 payload。
func TestNotifyReviewCarriesSnapshotFromPayload(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	author := newUser(t, ctx, pool, "author")
	mod := newUser(t, ctx, pool, "mod")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)

	// 第一次判定：拒绝（payload 里带着那一刻的状态与理由）
	if err := svc.NotifyReview(ctx, CreateNotifyInput{
		RefType: RefTopic, RefID: topic, State: "rejected", Text: "来源不明",
	}); err != nil {
		t.Fatal(err)
	}
	// 作者在通知被消费之前又改好了，管理员紧接着放行
	if _, err := pool.Exec(ctx,
		"UPDATE topics SET review_state = 'approved', review_note = NULL, reviewed_by = $2, reviewed_at = now() WHERE id = $1",
		topic, mod); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyReview(ctx, CreateNotifyInput{
		RefType: RefTopic, RefID: topic, State: "approved",
	}); err != nil {
		t.Fatal(err)
	}

	// 去重键是 review:topic:<id>（uq_notifications_user_dedup），两次判定落在一行上。
	// 但这**一行必须是先发生的那一次判定**：拒绝理由弄丢了就再也补不回来。
	var payload string
	if err := pool.QueryRow(ctx,
		"SELECT payload::text FROM notifications WHERE user_id = $1 AND type = 'review' ORDER BY id LIMIT 1",
		author).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var got struct {
		State string `json:"state"`
		Text  string `json:"text"`
	}
	if err := json.Unmarshal([]byte(payload), &got); err != nil {
		t.Fatal(err)
	}
	if got.State != "rejected" || got.Text != "来源不明" {
		t.Fatalf("审核通知必须带判定那一刻的快照，实际 state=%q text=%q（%s）", got.State, got.Text, payload)
	}
}
func TestNotifySkipsBannedRecipientsAndRespectsSettings(t *testing.T) {
	ctx, client, pool := newDB(t)
	settings := defaultSettings{byUser: map[int64]NoticeSetting{}}
	svc := newService(t, client, pool, settings)
	author := newUser(t, ctx, pool, "author")
	banned := newUser(t, ctx, pool, "banned")
	liker := newUser(t, ctx, pool, "liker")
	quiet := newUser(t, ctx, pool, "quiet")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)

	settings.byUser[author] = NoticeSetting{Alert: true, ReplyScope: "none", MentionScope: "all", LikeAlert: false}
	setUserStatus(t, ctx, pool, banned, "banned")

	post := newPost(t, ctx, pool, topic, banned, nil)
	if err := svc.NotifyReply(ctx, CreateNotifyInput{ActorID: liker, RefType: RefPost, RefID: post, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", banned); n != 0 {
		t.Fatalf("banned 收件人不发，实际 %d", n)
	}

	// author 关掉了回复提醒与点赞提醒
	p2 := newPost(t, ctx, pool, topic, author, nil)
	if err := svc.NotifyReply(ctx, CreateNotifyInput{ActorID: liker, RefType: RefPost, RefID: p2, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if err := svc.NotifyLike(ctx, CreateNotifyInput{ActorID: liker, RefType: RefPost, RefID: p2, TopicID: topic}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", author); n != 0 {
		t.Fatalf("reply_scope=none / like_alert=false 时都不该发，实际 %d", n)
	}

	// 总开关关掉：连处罚通知也不发
	settings.byUser[quiet] = NoticeSetting{Alert: false, ReplyScope: "all", MentionScope: "all", LikeAlert: true}
	admin := newUser(t, ctx, pool, "admin")
	sanction := newSanction(t, ctx, pool, quiet, admin, nil)
	if err := svc.NotifySanction(ctx, CreateNotifyInput{ActorID: admin, RefType: RefSanction, RefID: sanction}); err != nil {
		t.Fatal(err)
	}
	if n := countNotifications(t, ctx, pool, "user_id = $1", quiet); n != 0 {
		t.Fatalf("总开关关掉后不该有任何通知，实际 %d", n)
	}
}

func TestTaskEntryIsIdempotentOnReplay(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	author := newUser(t, ctx, pool, "author")
	replier := newUser(t, ctx, pool, "replier")
	board := newBoard(t, ctx, pool, "mod")
	topic := newTopic(t, ctx, pool, board, author)
	post := newPost(t, ctx, pool, topic, author, nil)

	in := CreateNotifyInput{ActorID: replier, RefType: RefPost, RefID: post, TopicID: topic}
	for i := 0; i < 3; i++ {
		if err := svc.NotifyReply(ctx, in); err != nil {
			t.Fatal(err)
		}
	}
	if n := countNotifications(t, ctx, pool, ""); n != 1 {
		t.Fatalf("任务重放三次仍该只有一条，实际 %d", n)
	}
	var readAt *time.Time
	if err := pool.QueryRow(ctx, "SELECT read_at FROM notifications").Scan(&readAt); err != nil {
		t.Fatal(err)
	}
	if readAt != nil {
		t.Fatal("重放不该改已读状态")
	}
}

func TestPurgeOnlyRemovesExpiredSoftDeleted(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")
	for i := int64(1); i <= 3; i++ {
		if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
			return svc.Create(ctx, tx, CreateInput{UserID: u, Kind: KindReply, RefType: RefPost, RefID: i})
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
UPDATE notifications SET deleted_at = CASE WHEN id = 1 THEN now() - interval '100 days' ELSE now() END`); err != nil {
		t.Fatal(err)
	}
	n, err := svc.Purge(ctx, clock.Real{}.Now().Add(-90*24*time.Hour), 5000)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("只该硬删超过保留期的那条，实际 %d", n)
	}
	if c := countNotifications(t, ctx, pool, ""); c != 2 {
		t.Fatalf("保留期内与未删的行都要留下，实际 %d", c)
	}
}

func TestConcurrentCreateKeepsSingleRow(t *testing.T) {
	ctx, client, pool := newDB(t)
	svc := newService(t, client, pool, nil)
	u := newUser(t, ctx, pool, "alice")
	other := newUser(t, ctx, pool, "bob")

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = db.WithTx(ctx, client, func(tx *ent.Tx) error {
				return svc.Create(ctx, tx, CreateInput{UserID: u, ActorID: other, Kind: KindReply, RefType: RefPost, RefID: 5})
			})
		}()
	}
	wg.Wait()
	if n := countNotifications(t, ctx, pool, ""); n != 1 {
		t.Fatalf("并发重放仍该只有一行（唯一索引兜住），实际 %d", n)
	}
}

// ---------- 契约自检 ----------

func TestTaskTypeConstantsMatchQueuePackage(t *testing.T) {
	// 两处同名常量必须逐字相同，否则 worker 注册的类型与业务入队的类型会对不上
	if TypeNotifyReply != queue.TypeNotifyReply || TypeNotifyReward != queue.TypeNotifyReward {
		t.Fatalf("notify 的任务类型常量与 platform/queue 不一致: %s/%s vs %s/%s",
			TypeNotifyReply, TypeNotifyReward, queue.TypeNotifyReply, queue.TypeNotifyReward)
	}
}

func TestCheckConstraintsMatchGoConstants(t *testing.T) {
	ctx, _, pool := newDB(t)
	def := constraintDef(t, ctx, pool, "ck_notifications_type")
	for _, k := range []string{KindReply, KindMention, KindLike, KindReward, KindReview, KindSanction, KindSystem} {
		if !strings.Contains(def, "'"+k+"'") {
			t.Fatalf("CHECK 里缺少类别 %q: %s", k, def)
		}
	}
	if strings.Contains(def, "'link'") {
		t.Fatalf("link 只该出现在 notification_mutes 的 CHECK 里: %s", def)
	}
	def = constraintDef(t, ctx, pool, "ck_notification_mutes_type")
	for _, k := range []string{KindReply, KindLink, KindSystem} {
		if !strings.Contains(def, "'"+k+"'") {
			t.Fatalf("静音 CHECK 里缺少 %q: %s", k, def)
		}
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO notifications (public_id, user_id, type) VALUES (gen_random_uuid(), (SELECT id FROM users LIMIT 1), 'nonsense')`); err == nil {
		t.Fatal("非法 type 必须被 CHECK 挡住")
	}
}

func TestDedupKeyShapeMatchesCheckConstraint(t *testing.T) {
	ctx, _, pool := newDB(t)
	u := newUser(t, ctx, pool, "alice")
	for _, key := range []string{
		DedupKey(KindReply, RefPost, 42),
		DedupKey(KindMention, RefComment, 88),
		DedupKey(KindReward, RefDonation, 7),
		DedupKey(KindSanction, RefSanction, 3),
	} {
		if _, err := pool.Exec(ctx, `
INSERT INTO notifications (public_id, user_id, type, dedup_key) VALUES (gen_random_uuid(), $1, 'review', $2)`, u, key); err != nil {
			t.Fatalf("dedup_key %q 被 ck_notifications_dedup_prefix 拒绝: %v", key, err)
		}
	}
}

// ---------- 路由 ----------

func TestRegisterRoutesDoNotConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	h := NewHandler(nil, func(*gin.Context) (*authz.Actor, bool) { return actor(1), true })
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("注册路由 panic（静态段与 /:id 冲突）: %v", r)
			}
		}()
		h.Register(engine.Group("/api/v1"), noop)
	}()
	got := map[string]bool{}
	for _, rt := range engine.Routes() {
		got[rt.Method+" "+rt.Path] = true
	}
	for _, want := range []string{
		"GET /api/v1/notifications",
		"GET /api/v1/notifications/unread-count",
		"POST /api/v1/notifications/read",
		"PUT /api/v1/notifications/mutes",
		"DELETE /api/v1/notifications/mutes",
		"DELETE /api/v1/notifications/:id",
	} {
		if !got[want] {
			t.Fatalf("缺少路由 %s（实际 %v）", want, got)
		}
	}
}

func constraintDef(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) string {
	t.Helper()
	var def string
	if err := pool.QueryRow(ctx, `
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = $1`, name).Scan(&def); err != nil {
		t.Fatalf("读约束 %s 失败: %v", name, err)
	}
	return def
}
