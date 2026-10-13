package title

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

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
		for _, fix := range migrationFixes {
			ddl = strings.ReplaceAll(ddl, fix.from, fix.to)
		}
		if _, err := conn.Conn().PgConn().Exec(ctx, ddl).ReadAll(); err != nil {
			t.Fatalf("跑迁移 %s 失败: %v", name, err)
		}
	}
}

// shortcut: 0004_forum 给 board_acls / topic_images 同时声明了 id 主键与自然键主键，PG 直接拒绝
// （SQLSTATE 42P16），整个迁移跑不起来。这里在测试侧把那两行降级为 UNIQUE 让用例能跑；
// 真修在迁移文件里（已报 Lead）。这两张表本域一行都不碰，形状差异不影响任何断言。
var migrationFixes = []struct{ from, to string }{
	{"  PRIMARY KEY (board_id, role_id),", "  UNIQUE (board_id, role_id),"},
	{"  PRIMARY KEY (topic_id, post_id, image_hash),", "  UNIQUE (topic_id, post_id, image_hash),"},
}

// fakeAudit 记账：title 的三个写操作必须留痕，Equip 不写（d4 §2.5）。
type fakeAudit struct {
	mu      sync.Mutex
	entries []AuditEntry
	err     error
}

func (f *fakeAudit) Log(_ context.Context, e AuditEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.entries = append(f.entries, e)
	return nil
}

func (f *fakeAudit) actions() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.entries))
	for _, e := range f.entries {
		out = append(out, e.Action)
	}
	return out
}

type fixture struct {
	ctx     context.Context
	client  *ent.Client
	pool    *pgxpool.Pool
	svc     *Service
	audit   *fakeAudit
	adminID int64
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx, client, pool := newDB(t)
	// 管理员必须是**另一个**用户：ck_user_titles_not_self 不允许自己给自己发头衔
	adminID := newUser(t, ctx, pool, "root")
	f := &fixture{ctx: ctx, client: client, pool: pool, audit: &fakeAudit{}, adminID: adminID}
	f.svc = NewService(client, client, clock.Real{}, f.audit)
	return f
}

func (f *fixture) admin() *authz.Actor {
	return &authz.Actor{UserID: f.adminID, Perms: authz.NewSet(authz.PermTitleGrant, authz.PermTitleManage)}
}

func (f *fixture) plain(userID int64) *authz.Actor { return &authz.Actor{UserID: userID} }

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

func (f *fixture) createTitle(t *testing.T, key, name string) *TitleDTO {
	t.Helper()
	dto, err := f.svc.CreateTitle(f.ctx, f.admin(), TitleInput{Key: key, Name: name, Color: "#2563eb"})
	if err != nil {
		t.Fatalf("造头衔 %s 失败: %v", key, err)
	}
	return dto
}

func isCode(err error, code string) bool {
	var ae *apperr.Error
	return errors.As(err, &ae) && ae.Code == code
}

func countRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
