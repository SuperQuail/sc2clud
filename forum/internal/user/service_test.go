package user

// user 模块的集成测试：真 PG + 独立 schema（拍板 §5.8）。
// 它只读 users，所以夹具直接插行；topic_count / like_received 两条 LATERAL 需要 topics / posts / likes 三张表，
// 那三张由 ent 的 Schema.Create 一并建出来（本域不写它们，只读）。

import (
	"context"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

type fixture struct {
	t    *testing.T
	ctx  context.Context
	pool *pgxpool.Pool
	db   *ent.Client
	svc  *Service
	clk  *clock.Fake
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })
	if err := client.Schema.Create(ctx); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	clk := &clock.Fake{T: time.Date(2026, 10, 13, 4, 0, 0, 0, time.UTC)}
	return &fixture{t: t, ctx: ctx, pool: pool, db: client,
		svc: NewService(client, nil, clk, Config{NicknameMax: 20, ProfileMax: 200}), clk: clk}
}

func (f *fixture) mustExec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatalf("执行 SQL 失败 (%s): %v", sql, err)
	}
}

// insertUser 插一行用户并返回自增 id。
func (f *fixture) insertUser(username, nickname, status string, exp int) int64 {
	f.t.Helper()
	f.mustExec("INSERT INTO roles (key, name, depth, is_system, is_super) VALUES ('user','普通用户',0,true,false) ON CONFLICT (key) DO NOTHING")
	var id int64
	err := f.pool.QueryRow(f.ctx,
		"INSERT INTO users (public_id, username, email, password_hash, nickname, role_id, status, exp, level, activated_at) "+
			"VALUES (gen_random_uuid(), $1, $2, '!', $3, (SELECT id FROM roles WHERE key='user'), $4, $5, 1, now()) RETURNING id",
		username, username+"@example.com", nickname, status, exp).Scan(&id)
	if err != nil {
		f.t.Fatalf("插用户失败: %v", err)
	}
	return id
}

// 用例 67/68/69/70：大小写不敏感、不存在 404、封禁可见、注销 404。
func TestProfileLookup(t *testing.T) {
	f := newFixture(t)
	f.insertUser("TangTian", "唐天", "active", 1200)

	p, err := f.svc.GetProfile(f.ctx, "tangtian")
	if err != nil {
		t.Fatalf("小写 handle 查不到: %v", err)
	}
	p2, err := f.svc.GetProfile(f.ctx, "TangTian")
	if err != nil || p2.ID != p.ID {
		t.Fatalf("两种大小写返回了不同的人: %v", err)
	}
	if p.Handle != "TangTian" || p.Nickname != "唐天" {
		t.Fatalf("资料字段不对: %+v", p)
	}
	// 用例 71：exp=1200 → level 3、exp_max 1600（设计 §12）。
	if p.Level != 3 || p.ExpMax != 1600 {
		t.Fatalf("level=%d exp_max=%d，想要 3 / 1600", p.Level, p.ExpMax)
	}

	if _, err := f.svc.GetProfile(f.ctx, "nobody"); err != apperr.ErrNotFound {
		t.Fatalf("不存在的人 -> %v，想要 404", err)
	}

	f.insertUser("banned-one", "被封的", "banned", 0)
	pb, err := f.svc.GetProfile(f.ctx, "banned-one")
	if err != nil {
		t.Fatalf("封禁用户应当仍可访问（设计 §11.1）: %v", err)
	}
	if pb.Status != "banned" {
		t.Fatalf("status = %q", pb.Status)
	}

	f.insertUser("gone", "注销的", "deleted", 0)
	if _, err := f.svc.GetProfile(f.ctx, "gone"); err != apperr.ErrNotFound {
		t.Fatalf("注销用户 -> %v，想要 404", err)
	}
}

// 用例 72/73：topic_count 只算 normal+approved，like_received 只算 status=normal 的帖子。
func TestProfileCounts(t *testing.T) {
	f := newFixture(t)
	author := f.insertUser("author", "作者", "active", 0)
	other := f.insertUser("voter", "投票的", "active", 0)
	f.mustExec("INSERT INTO boards (public_id, slug, name, created_at, updated_at) VALUES (gen_random_uuid(), 'b', '版块', now(), now())")
	boardID := f.queryInt("SELECT id FROM boards LIMIT 1")
	// 两条主题：一条正常，一条 hidden（不该被算进 topic_count）。
	f.mustExec("INSERT INTO topics (public_id, board_id, author_id, title, kind, visibility, review_state, created_at, updated_at) "+
		"VALUES (gen_random_uuid(), $1, $2, '可见', 'discussion', 'normal', 'approved', now(), now())", boardID, author)
	f.mustExec("INSERT INTO topics (public_id, board_id, author_id, title, kind, visibility, review_state, created_at, updated_at) "+
		"VALUES (gen_random_uuid(), $1, $2, '隐藏', 'discussion', 'hidden', 'approved', now(), now())", boardID, author)
	topicID := f.queryInt("SELECT id FROM topics WHERE title = '可见'")
	postID := f.queryInt("INSERT INTO posts (public_id, topic_id, author_id, content, status, created_at, updated_at) "+
		"VALUES (gen_random_uuid(), $1, $2, '正文', 'normal', now(), now()) RETURNING id", topicID, author)
	// 一条已删帖的赞：不该算进 like_received。
	deletedPost := f.queryInt("INSERT INTO posts (public_id, topic_id, author_id, content, status, created_at, updated_at) "+
		"VALUES (gen_random_uuid(), $1, $2, '删掉的', 'deleted', now(), now()) RETURNING id", topicID, author)
	f.mustExec("INSERT INTO likes (target_type, target_id, user_id, value, created_at) VALUES ('post', $1, $2, 1, now())", postID, other)
	f.mustExec("INSERT INTO likes (target_type, target_id, user_id, value, created_at) VALUES ('post', $1, $2, 1, now())", deletedPost, other)

	p, err := f.svc.GetProfile(f.ctx, "author")
	if err != nil {
		t.Fatal(err)
	}
	if p.TopicCount != 1 {
		t.Fatalf("topic_count = %d，想要 1（只算 normal+approved）", p.TopicCount)
	}
	if p.LikeReceived != 1 {
		t.Fatalf("like_received = %d，想要 1（已删帖的赞不算）", p.LikeReceived)
	}
}

// 用例 74/75/76/77：重名标记、两条前缀路径、limit 上限、排除封禁。
func TestSearchUsers(t *testing.T) {
	f := newFixture(t)
	f.insertUser("tangtian", "唐天", "active", 0)
	f.insertUser("tangtian2", "唐天", "active", 0) // 同昵称 → ambiguous
	f.insertUser("tom", "汤姆", "active", 0)
	f.insertUser("banneduser", "唐天", "banned", 0)

	// 昵称前缀命中。
	rows, err := f.svc.Search(f.ctx, "唐", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("按昵称搜到 %d 行，想要 2（封禁用户不进结果）", len(rows))
	}
	for _, r := range rows {
		if !r.Ambiguous {
			t.Fatalf("同昵称的两行都应当 ambiguous=true: %+v", r)
		}
	}

	// username 前缀命中（另一条路径）。
	rows, err = f.svc.Search(f.ctx, "tom", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Handle != "tom" {
		t.Fatalf("按 username 搜到 %+v", rows)
	}
	if rows[0].Ambiguous {
		t.Fatal("唯一昵称被标成 ambiguous")
	}

	// limit 上限 20（拍板 §5.1 同款口径：超出按上限，不报错）。
	for i := 0; i < 30; i++ {
		f.insertUser("prefix"+string(rune('a'+i%26))+string(rune('a'+i/26)), "前缀", "active", 0)
	}
	rows, err = f.svc.Search(f.ctx, "prefix", 999)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) > 20 {
		t.Fatalf("limit=999 返回了 %d 行，上限是 20", len(rows))
	}

	if _, err := f.svc.Search(f.ctx, "", 10); err == nil {
		t.Fatal("空 q 没有报错")
	}
}

func (f *fixture) queryInt(sql string, args ...any) int64 {
	f.t.Helper()
	var n int64
	if err := f.pool.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatalf("查询失败 (%s): %v", sql, err)
	}
	return n
}
