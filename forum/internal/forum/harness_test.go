package forum

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	ent "forum/internal/ent"
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	"forum/internal/platform/db"
	"forum/internal/platform/queue"
	"forum/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/authz"
)

func TestMain(m *testing.M) { testsupport.Main(m); os.Exit(0) }

// ---- 测试台 ----
//
// 每个用例一个独立 schema + 真迁移（不是 ent 生成的表结构）：CHECK、部分唯一索引、
// 数组默认值这些「只在迁移里存在」的东西必须被测到，否则测的是一个不存在的库。

type harness struct {
	t     *testing.T
	ctx   context.Context
	pool  *pgxpool.Pool
	ent   *ent.Client
	svc   *Service
	clk   *clock.Fake
	queue *fakeQueue
	count *fakeCounter
	deps  *fakeDeps
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	migrateAll(t, ctx, pool)
	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })

	clk := &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)}
	fq := &fakeQueue{}
	fc := &fakeCounter{m: map[string]int64{}}
	fd := &fakeDeps{t: t, ctx: ctx, pool: pool}
	svc := NewService(client, clk, fc, fq, Deps{
		Users: fd, Render: markdownish{}, Queue: fq, Counter: fc,
	})
	return &harness{t: t, ctx: ctx, pool: pool, ent: client, svc: svc, clk: clk, queue: fq, count: fc, deps: fd}
}

func migrateAll(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".up.sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	for _, name := range files {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(b)); err != nil {
			t.Fatalf("迁移 %s 失败: %v", name, err)
		}
	}
}

// ---- 假依赖 ----

type fakeQueue struct {
	mu    sync.Mutex
	tasks []queue.Task
}

func (q *fakeQueue) EnqueueTx(_ context.Context, _ *ent.Tx, t queue.Task) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tasks = append(q.tasks, t)
	return nil
}

func (q *fakeQueue) types() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := make([]string, 0, len(q.tasks))
	for _, t := range q.tasks {
		out = append(out, t.Type)
	}
	return out
}

func (q *fakeQueue) reset() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tasks = nil
}

type fakeCounter struct {
	mu sync.Mutex
	m  map[string]int64
}

func (c *fakeCounter) Add(key string, delta int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] += delta
}

func (c *fakeCounter) Get(key string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.m[key]
}

// markdownish 是 Renderer 的测试替身：把 <b> 当「清洗过的 HTML」的代表。
// 真渲染器（platform/markdown）不属于本域，本域只要求 html 与 plain 同源。
type markdownish struct{}

func (markdownish) Render(md string) (string, string) {
	return "<p>" + md + "</p>", md
}

type fakeDeps struct {
	t    *testing.T
	ctx  context.Context
	pool *pgxpool.Pool
}

func (d *fakeDeps) GetAuthBrief(ctx context.Context, userID int64) (*UserAuthBrief, error) {
	var b UserAuthBrief
	err := d.pool.QueryRow(ctx, "SELECT id, trusted, level, status FROM users WHERE id = $1", userID).
		Scan(&b.ID, &b.Trusted, &b.Level, &b.Status)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (d *fakeDeps) ByHandle(ctx context.Context, handle string) (*UserBrief, error) {
	var b UserBrief
	var avatar, small *string
	err := d.pool.QueryRow(ctx,
		"SELECT id, public_id, username, nickname, avatar_hash, avatar_small_hash, status FROM users WHERE lower(username) = lower($1)",
		handle).Scan(&b.ID, &b.PublicID, &b.Handle, &b.Nickname, &avatar, &small, &b.Status)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// ---- 造数据 ----

// seedRole 取（必要时建）一个角色并返回它的 id。
// **ON CONFLICT**：0017_seed_authz 已经建过 user / admin / superadmin，重复插会撞唯一键。
func (h *harness) seedRole(key string, isSuper bool) int64 {
	h.t.Helper()
	var id int64
	err := h.pool.QueryRow(h.ctx, `
INSERT INTO roles (key, name, is_super) VALUES ($1, $1, $2)
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name
RETURNING id`, key, isSuper).Scan(&id)
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// seedUser 建一个用户。level 直接写（等级公式的唯一实现在 D4，本域只读它）。
func (h *harness) seedUser(handle string, roleID int64, level int, trusted bool) int64 {
	h.t.Helper()
	var id int64
	err := h.pool.QueryRow(h.ctx, `
INSERT INTO users (public_id, username, email, password_hash, nickname, role_id, level, trusted)
VALUES ($1, $2, $3, 'x', $2, $4, $5, $6) RETURNING id`,
		uuid.NewString(), handle, handle+"@example.com", roleID, level, trusted).Scan(&id)
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

func (h *harness) seedBoard(slug string, minPostLevel int, aclEnabled bool) int64 {
	h.t.Helper()
	var id int64
	err := h.pool.QueryRow(h.ctx, `
INSERT INTO boards (slug, name, min_post_level, acl_enabled) VALUES ($1, $1, $2, $3) RETURNING id`,
		slug, minPostLevel, aclEnabled).Scan(&id)
	if err != nil {
		h.t.Fatal(err)
	}
	return id
}

// actor 造一个带权限点的身份。roleID 是**基线角色**——ACL 是按 role_id 建行的。
func (h *harness) actor(userID, roleID int64, perms ...string) *authz.Actor {
	return &authz.Actor{
		UserID: userID, RoleID: roleID,
		Perms: authz.NewSet(perms...),
	}
}

// super 是超管身份：判定第 1 步就该短路，连 ACL 那条 SQL 都不查。
func (h *harness) super(userID, roleID int64) *authz.Actor {
	return &authz.Actor{UserID: userID, RoleID: roleID, IsSuper: true, Perms: authz.NewSet()}
}

// setACL 写一行分区 ACL。can/deny 用同一个 action（"post" 或 "reply"）。
func (h *harness) setACL(boardID, roleID int64, can, deny bool, action string) {
	h.t.Helper()
	post, reply := action == "post", action == "reply"
	_, err := h.pool.Exec(h.ctx, `
INSERT INTO board_acls (board_id, role_id, can_post, can_reply, deny_post, deny_reply)
VALUES ($1, $2, $3, $4, $5, $6)`, boardID, roleID, can && post, can && reply, deny && post, deny && reply)
	if err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) sanction(userID int64, boardID *int64, action string, until *time.Time) {
	h.t.Helper()
	_, err := h.pool.Exec(h.ctx,
		"INSERT INTO sanctions (user_id, board_id, action, until) VALUES ($1, $2, $3, $4)",
		userID, boardID, action, until)
	if err != nil {
		h.t.Fatal(err)
	}
}

// assertCode 断言错误码。**每条权限用例都要断言码**，不只断言「失败」（§11.3 第 14 条）。
func assertCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("期望 %s，实际成功", want)
	}
	ae, ok := err.(*apperr.Error)
	if !ok {
		t.Fatalf("期望 %s，实际 %T: %v", want, err, err)
	}
	if ae.Code != want {
		t.Fatalf("期望 %s，实际 %s（%s）", want, ae.Code, ae.Msg)
	}
}

func (h *harness) mustTopic(actor *authz.Actor, in CreateTopicInput) *TopicDetailDTO {
	h.t.Helper()
	d, err := h.svc.CreateTopic(h.ctx, actor, in)
	if err != nil {
		h.t.Fatalf("发主题失败: %v", err)
	}
	return d
}

func (h *harness) countRows(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := h.pool.QueryRow(h.ctx, sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// dbTx 直接用 platform/db 的入口跑一段事务，用来验证回滚（§11.3 第 12 条）。
func (h *harness) dbTx(fn func(tx *ent.Tx) error) error {
	return db.WithTx(h.ctx, h.ent, fn)
}
