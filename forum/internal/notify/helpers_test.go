package notify

import (
	"context"
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

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/notify/pgsql"
	"forum/internal/platform/clock"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// newDB 给一个用例独立 schema，并把仓库里的迁移原样跑一遍：
// 测试看到的表形状与生产逐字相同（ent 的 Schema.Create 会造出与迁移不同的形状，不能用）。
func newDB(t *testing.T) (context.Context, *ent.Client, *pgxpool.Pool) {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	applyMigrations(t, ctx, pool)
	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })
	return ctx, client, pool
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
		ddl := string(raw)
		// 简单协议：一个迁移文件里的多条语句一次发过去
		if _, err := conn.Conn().PgConn().Exec(ctx, ddl).ReadAll(); err != nil {
			t.Fatalf("跑迁移 %s 失败: %v", name, err)
		}
	}
}

// newService 造一个只依赖数据库的 Service：通知设置由测试自己给（user 模块还没写）。
func newService(t *testing.T, client *ent.Client, pool *pgxpool.Pool, settings NoticeSettings) *Service {
	t.Helper()
	if settings == nil {
		settings = defaultSettings{}
	}
	return NewService(client, clock.Real{}, pgsql.New(client), settings)
}

// defaultSettings 等同于 user_notice_settings 的默认值（alert=true、两个 scope=all、like_alert=true）。
type defaultSettings struct {
	byUser map[int64]NoticeSetting
}

func (d defaultSettings) Get(_ context.Context, userID int64) (*NoticeSetting, error) {
	if s, ok := d.byUser[userID]; ok {
		return &s, nil
	}
	return &NoticeSetting{Alert: true, ReplyScope: "all", MentionScope: "all", LikeAlert: true}, nil
}

func actor(id int64) *authz.Actor { return &authz.Actor{UserID: id} }

// ---------- 夹具：别的域的表直接写 SQL（users / boards / topics / posts / ...）----------

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

func setUserStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, status string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `UPDATE users SET status = $2 WHERE id = $1`, userID, status); err != nil {
		t.Fatal(err)
	}
}

func newBoard(t *testing.T, ctx context.Context, pool *pgxpool.Pool, slug string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `INSERT INTO boards (slug, name) VALUES ($1, $1) RETURNING id`, slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func newTopic(t *testing.T, ctx context.Context, pool *pgxpool.Pool, boardID, authorID int64) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
INSERT INTO topics (public_id, board_id, author_id, title) VALUES (gen_random_uuid(), $1, $2, 't') RETURNING id`,
		boardID, authorID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func topicPublicID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, topicID int64) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, `SELECT public_id::text FROM topics WHERE id = $1`, topicID).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func newPost(t *testing.T, ctx context.Context, pool *pgxpool.Pool, topicID, authorID int64, parentID *int64) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
INSERT INTO posts (public_id, topic_id, author_id, parent_id, floor, content_md, content_html)
VALUES (gen_random_uuid(), $1, $2, $3, (SELECT COALESCE(max(floor), 0) + 1 FROM posts WHERE topic_id = $1), 'x', 'x')
RETURNING id`, topicID, authorID, parentID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func newIssue(t *testing.T, ctx context.Context, pool *pgxpool.Pool, topicID, authorID int64) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
INSERT INTO post_issues (public_id, topic_id, author_id, number, kind, title, body_md, body_html)
VALUES (gen_random_uuid(), $1, $2, 1, 'bug', 'i', 'x', 'x') RETURNING id`, topicID, authorID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func newIssueComment(t *testing.T, ctx context.Context, pool *pgxpool.Pool, issueID, authorID int64) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
INSERT INTO issue_comments (public_id, issue_id, author_id, body_md, body_html)
VALUES (gen_random_uuid(), $1, $2, 'x', 'x') RETURNING id`, issueID, authorID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func newDonation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, donorID, recipientID int64, state string) int64 {
	t.Helper()
	var id int64
	// ck_donation_records_verified：approved / rejected 必须同时有 verified_by 与 verified_at
	if err := pool.QueryRow(ctx, `
INSERT INTO donation_records (public_id, donor_id, recipient_id, amount_cents, state, verified_by, verified_at)
VALUES (gen_random_uuid(), $1::bigint, $2::bigint, 1234, $3::text,
        CASE WHEN $3::text IN ('approved','rejected') THEN $1::bigint END,
        CASE WHEN $3::text IN ('approved','rejected') THEN now() END)
RETURNING id`, donorID, recipientID, state).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func newSanction(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID, byID int64, until *time.Time) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `
INSERT INTO sanctions (user_id, reason, until, created_by) VALUES ($1, '刷屏', $2, $3) RETURNING id`,
		userID, until, byID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func countNotifications(t *testing.T, ctx context.Context, pool *pgxpool.Pool, where string, args ...any) int {
	t.Helper()
	q := "SELECT count(*) FROM notifications"
	if where != "" {
		q += " WHERE " + where
	}
	var n int
	if err := pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func notificationText(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int64, col string) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(ctx, "SELECT "+col+" FROM notifications WHERE id = $1", id).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}
