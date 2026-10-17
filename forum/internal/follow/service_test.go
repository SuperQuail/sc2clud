package follow

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	ent "forum/internal/ent"
	followpgsql "forum/internal/follow/pgsql"
	"forum/internal/platform/apperr"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// newService 跑**仓库真迁移**再建 service：测试看到的表形状与生产逐字相同
// （ent 的 Schema.Create 会造出与迁移不同的形状，不能用 —— 与 notify/appeal 同一个理由）。
func newService(t *testing.T) (context.Context, *pgxpool.Pool, *Service) {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	applyMigrations(t, ctx, pool)
	// **不带 public.**：testsupport 每个用例一个独立 schema，表在 search_path 里的那一份
	// （写 public.follows 会去查另一个 schema，于是「表不存在」而迁移其实跑过了）。
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass('follows') IS NOT NULL").Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("迁移跑完却没有 follows 表：0040_follows.up.sql 没被跑到")
	}
	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })
	return ctx, pool, NewService(followpgsql.New(client))
}

func applyMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".up.sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Conn().PgConn().Exec(ctx, string(raw)).ReadAll(); err != nil {
			t.Fatalf("跑迁移 %s 失败: %v", name, err)
		}
	}
}

// ---------- 夹具：users / boards 直接写 SQL（它们不是本域的表）----------

func newUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, username string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
INSERT INTO users (public_id, username, email, password_hash, nickname, role_id, status, activated_at)
VALUES (gen_random_uuid(), $1::varchar, $1::text || '@t.local', 'x', $1::varchar,
        (SELECT id FROM roles WHERE key = 'user'), 'active', now())
RETURNING id`, username).Scan(&id); err != nil {
		t.Fatalf("造用户 %s 失败: %v", username, err)
	}
	return id
}

func setStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, status string) {
	t.Helper()
	if _, err := pool.Exec(ctx, "UPDATE users SET status = $2 WHERE id = $1", userID, status); err != nil {
		t.Fatal(err)
	}
}

func newBoard(t *testing.T, ctx context.Context, pool *pgxpool.Pool, slug string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, "INSERT INTO boards (slug, name) VALUES ($1, $1) RETURNING id", slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// backdate 把一行关注的 created_at 挪到过去 —— 游标分页要「看得见变化」（假时钟那条账）。
func backdate(t *testing.T, ctx context.Context, pool *pgxpool.Pool, followerID, targetID int64, user bool, at time.Time) {
	t.Helper()
	col := "board_id"
	if user {
		col = "user_id"
	}
	if _, err := pool.Exec(ctx, "UPDATE follows SET created_at = $3 WHERE follower_id = $1 AND "+col+" = $2", followerID, targetID, at); err != nil {
		t.Fatal(err)
	}
}

func countRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, where string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM follows WHERE "+where, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------- 幂等 ----------

// **会红**：把 ON CONFLICT DO NOTHING 改成裸 INSERT 时这条第二次就报 23505。
func TestFollowUserIsIdempotent(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")
	other := newUser(t, ctx, pool, "other")

	first, err := svc.FollowUser(ctx, me, "other")
	if err != nil {
		t.Fatalf("第一次关注失败: %v", err)
	}
	if !first.Following || first.FollowerCount != 1 {
		t.Fatalf("第一次关注后应 following=true / count=1，实际 %+v", first)
	}
	second, err := svc.FollowUser(ctx, me, "other")
	if err != nil {
		t.Fatalf("重复关注必须幂等（不能 409/500）: %v", err)
	}
	if !second.Following || second.FollowerCount != 1 {
		t.Fatalf("重复关注后仍是 following=true / count=1，实际 %+v", second)
	}
	// handle 大小写不敏感（与 user 域的 GetProfile 同一口径）
	if _, err := svc.FollowUser(ctx, me, "OTHER"); err != nil {
		t.Fatalf("大写 handle 也该命中同一个人: %v", err)
	}
	if n := countRows(t, ctx, pool, "follower_id = $1 AND user_id = $2", me, other); n != 1 {
		t.Fatalf("重复关注只能有一行，实际 %d 行", n)
	}
}

func TestFollowBoardIsIdempotentAndUnfollowTwice(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")
	newBoard(t, ctx, pool, "general")

	if _, err := svc.FollowBoard(ctx, me, "general"); err != nil {
		t.Fatalf("关注分区失败: %v", err)
	}
	st, err := svc.FollowBoard(ctx, me, "general")
	if err != nil {
		t.Fatalf("重复关注分区失败: %v", err)
	}
	if !st.Following || st.FollowerCount != 1 || st.Target != TargetBoard || st.Slug != "general" {
		t.Fatalf("重复关注后状态不对: %+v", st)
	}

	off, err := svc.UnfollowBoard(ctx, me, "general")
	if err != nil {
		t.Fatalf("取关失败: %v", err)
	}
	if off.Following || off.FollowerCount != 0 {
		t.Fatalf("取关后应 following=false / count=0，实际 %+v", off)
	}
	// 重复取关：不存在的关注也要 204 语义（幂等），不是 404
	again, err := svc.UnfollowBoard(ctx, me, "general")
	if err != nil {
		t.Fatalf("重复取关必须幂等: %v", err)
	}
	if again.Following || again.FollowerCount != 0 {
		t.Fatalf("重复取关后状态不对: %+v", again)
	}
	if n := countRows(t, ctx, pool, "follower_id = $1", me); n != 0 {
		t.Fatalf("取关后不该留行，实际 %d 行", n)
	}
}

// **会红**：去掉 service 里那条 self 判定就会得到 500（ck_follows_self 是数据库兜底，冒到 HTTP 不是 400）。
func TestCannotFollowSelf(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")

	_, err := svc.FollowUser(ctx, me, "me")
	var appErr *apperr.Error
	if !errors.As(err, &appErr) || appErr.Status != 400 {
		t.Fatalf("关注自己应是 400，实际 %v", err)
	}
	if n := countRows(t, ctx, pool, "follower_id = $1", me); n != 0 {
		t.Fatalf("关注自己不该落行，实际 %d 行", n)
	}
}

// **会红**：把 ck_follows_target 去掉，就能插出「同时关注一个人和一个分区」或「两个都空」的行，
// 而计数与列表会各自按自己的理解解释这种行。
func TestTargetMustBeExactlyOne(t *testing.T) {
	ctx, pool, _ := newService(t)
	me := newUser(t, ctx, pool, "me")
	other := newUser(t, ctx, pool, "other")
	board := newBoard(t, ctx, pool, "general")

	if _, err := pool.Exec(ctx, "INSERT INTO follows (follower_id) VALUES ($1)", me); err == nil {
		t.Fatal("两个目标都为空的行必须被 ck_follows_target 拒掉")
	}
	if _, err := pool.Exec(ctx, "INSERT INTO follows (follower_id, user_id, board_id) VALUES ($1,$2,$3)", me, other, board); err == nil {
		t.Fatal("同时给 user_id 与 board_id 的行必须被 ck_follows_target 拒掉")
	}
}

// 关注**不发通知**（拍板 L5：暂时不需要做关注后的推送，算备用）。
// **会红**：以后谁顺手在 Follow 里加一条 notify 写入，这条立刻红 —— 那时要么改这条用例并给出理由，
// 要么（更可能）是搞错了：拍板说备用。
func TestFollowSendsNoNotification(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")
	other := newUser(t, ctx, pool, "other")
	newBoard(t, ctx, pool, "general")

	if _, err := svc.FollowUser(ctx, me, "other"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.FollowBoard(ctx, me, "general"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM notifications WHERE user_id = $1", other).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("关注不该产生通知（拍板 L5：推送算备用），实际 %d 条", n)
	}
}

// ---------- 列表与游标 ----------

// **会红**：把游标比较写成 <= 时第二页会重复第一条；把 id 兜底去掉时同一时刻的三行会漏。
func TestListFollowingUsersCursorWithoutGapsOrDupes(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")
	a := newUser(t, ctx, pool, "aaa")
	b := newUser(t, ctx, pool, "bbb")
	c := newUser(t, ctx, pool, "ccc")

	base := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	// 三条**同一时刻**：只靠 created_at 排不出稳定顺序，id 兜底那一段就是为它们写的
	for _, id := range []int64{a, b, c} {
		if _, err := svc.FollowUser(ctx, me, handleOf(t, ctx, pool, id)); err != nil {
			t.Fatal(err)
		}
		backdate(t, ctx, pool, me, id, true, base)
	}

	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 4; page++ {
		res, err := svc.MyUsers(ctx, me, ListInput{Cursor: cursor, Limit: 1})
		if err != nil {
			t.Fatalf("第 %d 页失败: %v", page, err)
		}
		if len(res.Items) == 0 {
			break
		}
		if seen[res.Items[0].Handle] {
			t.Fatalf("游标分页出现重复行: %s", res.Items[0].Handle)
		}
		seen[res.Items[0].Handle] = true
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	if len(seen) != 3 {
		t.Fatalf("三条关注要一页一条地翻完，实际看到 %d 条（%v）", len(seen), seen)
	}

	// 坏游标是 400，不是 500
	if _, err := svc.MyUsers(ctx, me, ListInput{Cursor: "不是游标"}); err == nil {
		t.Fatal("非法游标必须报错")
	} else {
		var appErr *apperr.Error
		if !errors.As(err, &appErr) || appErr.Status != 400 {
			t.Fatalf("非法游标应是 400，实际 %v", err)
		}
	}
}

// 粉丝列表里**已注销的人照旧出现**（否则计数与列表对不上），而「我关注的人」里不出现。
func TestFollowingListHidesDeletedButFollowersKeepThem(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")
	gone := newUser(t, ctx, pool, "gone")
	if _, err := svc.FollowUser(ctx, me, "gone"); err != nil {
		t.Fatal(err)
	}
	setStatus(t, ctx, pool, gone, "deleted")

	mine, err := svc.MyUsers(ctx, me, ListInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine.Items) != 0 {
		t.Fatalf("已注销的人不该留在「我关注的人」里: %+v", mine.Items)
	}
	// 但**关注数仍然算他**：粉丝数是事实，不是「列表里有几行」。
	// 用一个没注销的人当被关注对象（他有一个已注销的粉丝）。
	live := newUser(t, ctx, pool, "live")
	if _, err := svc.FollowUser(ctx, gone, handleOf(t, ctx, pool, live)); err != nil {
		t.Fatal(err)
	}
	st, err := svc.UserState(ctx, 0, "live")
	if err != nil {
		t.Fatal(err)
	}
	if st.FollowerCount != 1 {
		t.Fatalf("粉丝数要含已注销的关注者，实际 %d", st.FollowerCount)
	}
	fans, err := svc.Followers(ctx, TargetUser, "live", ListInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(fans.Items) != 1 {
		t.Fatalf("粉丝列表里已注销的人**照旧出现**（否则计数与列表对不上），实际 %d 行", len(fans.Items))
	}

	// 已注销的人自己：handle 查不到 = 404（与 user 域 GetProfile 同一口径）
	if _, err := svc.Followers(ctx, TargetUser, "gone", ListInput{}); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("已注销用户的关注者列表应 404，实际 %v", err)
	}
	if _, err := svc.UserState(ctx, 0, "gone"); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("已注销用户的关注状态应 404，实际 %v", err)
	}
}

func TestBoardFollowersList(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")
	other := newUser(t, ctx, pool, "other")
	newBoard(t, ctx, pool, "general")
	newBoard(t, ctx, pool, "archived")

	if _, err := svc.FollowBoard(ctx, me, "general"); err != nil {
		t.Fatal(err)
	}
	// 第二个人关注同一个分区：粉丝列表要有两行（下面断言 2）
	if _, err := svc.FollowBoard(ctx, other, "general"); err != nil {
		t.Fatal(err)
	}
	// 归档分区也能关注（归档只拦发帖）
	if _, err := svc.FollowBoard(ctx, me, "archived"); err != nil {
		t.Fatalf("归档分区应可关注: %v", err)
	}

	page, err := svc.Followers(ctx, TargetBoard, "general", ListInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("general 应有 2 个关注者，实际 %d", len(page.Items))
	}

	mine, err := svc.MyBoards(ctx, me, ListInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine.Items) != 2 {
		t.Fatalf("我关注了 2 个分区，实际 %d（%+v）", len(mine.Items), mine.Items)
	}
	// 归档分区不在「我关注的分区」列表里（与 users.status 那条同一个口径）
	if _, err := pool.Exec(ctx, "UPDATE boards SET status = 'archived' WHERE slug = 'archived'"); err != nil {
		t.Fatal(err)
	}
	mine, err = svc.MyBoards(ctx, me, ListInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine.Items) != 1 || mine.Items[0].Slug != "general" {
		t.Fatalf("归档分区不该留在列表里: %+v", mine.Items)
	}
}

// 「成员」格是给所有人看的：**未登录也要能读到关注数**，只是 following 恒 false。
// **会红**：把 UserState/BoardState 写成「先要 actor」时，游客拿 401、那一格又只能是 0。
func TestStateReadableSignedOut(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")
	newUser(t, ctx, pool, "other")
	newBoard(t, ctx, pool, "general")
	if _, err := svc.FollowUser(ctx, me, "other"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.FollowBoard(ctx, me, "general"); err != nil {
		t.Fatal(err)
	}

	us, err := svc.UserState(ctx, 0, "other")
	if err != nil {
		t.Fatalf("游客读用户关注数失败: %v", err)
	}
	if us.FollowerCount != 1 || us.Following {
		t.Fatalf("游客：count=1 / following=false，实际 %+v", us)
	}
	bs, err := svc.BoardState(ctx, 0, "general")
	if err != nil {
		t.Fatalf("游客读分区关注数失败: %v", err)
	}
	if bs.FollowerCount != 1 || bs.Following {
		t.Fatalf("游客：count=1 / following=false，实际 %+v", bs)
	}
	// 登录者看到的是 true
	on, err := svc.BoardState(ctx, me, "general")
	if err != nil {
		t.Fatal(err)
	}
	if !on.Following {
		t.Fatalf("关注者自己应看到 following=true: %+v", on)
	}
}

func TestUnknownTargetIsNotFound(t *testing.T) {
	ctx, pool, svc := newService(t)
	me := newUser(t, ctx, pool, "me")

	if _, err := svc.FollowUser(ctx, me, "nobody"); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("不存在的用户应 404，实际 %v", err)
	}
	if _, err := svc.FollowBoard(ctx, me, "no-such-board"); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("不存在的分区应 404，实际 %v", err)
	}
	if _, err := svc.UserState(ctx, 0, ""); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("空 handle 应 404，实际 %v", err)
	}
}

// handleOf 反查夹具里那个人的 username（测试自己写死的名字与 id 之间需要一座桥）。
func handleOf(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int64) string {
	t.Helper()
	var name string
	if err := pool.QueryRow(ctx, "SELECT username FROM users WHERE id = $1", id).Scan(&name); err != nil {
		t.Fatal(err)
	}
	return name
}
