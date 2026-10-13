package reward_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io/fs"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/clock"
	"forum/internal/platform/queue"
	"forum/internal/reward"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// ---- 起库：每用例独立 schema + 全部迁移（testsupport 结束时 DROP SCHEMA CASCADE）----

type harness struct {
	t       *testing.T
	ctx     context.Context
	db      *ent.Client
	pool    *pgxpool.Pool
	users   *fakeUsers
	set     *fakeSettings
	audit   *fakeAudit
	queue   *fakeQueue
	clk     *clock.Fake
	roleID  int64
	boardID int64

	alice, bob, admin user
}

type user struct {
	ID     int64
	Handle string
	Basic  reward.UserBasic
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	applyMigrations(t, ctx, pool)

	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })

	h := &harness{
		t:     t,
		ctx:   ctx,
		db:    client,
		pool:  pool,
		users: &fakeUsers{byID: map[int64]reward.UserBasic{}, byHandle: map[string]int64{}},
		set:   &fakeSettings{values: map[string]string{}},
		audit: &fakeAudit{},
		queue: &fakeQueue{},
		clk:   &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)},
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM roles ORDER BY id LIMIT 1`).Scan(&h.roleID); err != nil {
		t.Fatalf("读角色: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO boards (slug, name) VALUES ('general', '综合') RETURNING id`).Scan(&h.boardID); err != nil {
		t.Fatalf("建版块: %v", err)
	}
	h.alice = h.newUser("alice")
	h.bob = h.newUser("bob")
	h.admin = h.newUser("admin")
	return h
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
	for _, name := range names {
		raw, err := fs.ReadFile(os.DirFS(dir), name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, patchMigration(string(raw))); err != nil {
			t.Fatalf("迁移 %s: %v", name, err)
		}
	}
}

// patchMigration 兜住已确认的三处迁移缺陷。它们都不在本模块的写作用域（migrations/** 不许改），
// 所以只能在这里做等价修补，好让本模块的测试跑在真库上；迁移被正式修好后这里应当整体删掉：
//
//  1. 0004_forum 的 board_acls / topic_images 同时写了 "id ... PRIMARY KEY" 与复合 "PRIMARY KEY (...)"，
//     PostgreSQL 直接拒收（指定多个主键是不允许的）→ 迁移在 0004 就断，之后一张表都建不出来。
//     按 DDL 本意保留 id 主键，把复合/列内主键降成唯一约束（语义不变：仍唯一）。
//  2. 0011_reward / 0010_media 的三张表缺 ent 生成代码要的列：
//     user_donation_settings、donation_notice_defaults 缺 id（ent 的 SELECT 固定带 id），
//     payment_channels 缺 public_id（PaymentChannel schema 带 mixin.PublicID）。
func patchMigration(sql string) string {
	// 先补列，再降主键：补完之后这两张表才算「有两个主键」，降掉的是原来那个自然键
	for _, t := range []string{"user_donation_settings", "donation_notice_defaults"} {
		sql = strings.Replace(sql, "CREATE TABLE "+t+" (\n", "CREATE TABLE "+t+" (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n", 1)
	}

	// 收款码表补 public_id（schema 上是 mixin.PublicID；默认值只是为了让 NOT NULL 能加上）
	sql = strings.Replace(sql, "CREATE TABLE payment_channels (\n", "CREATE TABLE payment_channels (\n  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,\n", 1)
	return demotePrimaryKeys(sql)
}

// demotePrimaryKeys 把同一张表里的「第二个主键」降成 UNIQUE（保留唯一性，只是不再是主键）：
// 表级 PRIMARY KEY (…) 与列内 … PRIMARY KEY 两种写法都处理，保留每个块里第一个（即 id / public_id）。
func demotePrimaryKeys(sql string) string {
	for _, block := range createBlocks(sql) {
		if strings.Count(block, "PRIMARY KEY") < 2 {
			continue
		}
		seen := false
		fixed := strings.Split(block, "\n")
		for i, ln := range fixed {
			if !strings.Contains(ln, "PRIMARY KEY") {
				continue
			}
			if seen {
				fixed[i] = strings.Replace(ln, "PRIMARY KEY", "UNIQUE", 1)
			}
			seen = true
		}
		sql = strings.Replace(sql, block, strings.Join(fixed, "\n"), 1)
	}
	return sql
}

// createBlocks 切出每个完整的 "CREATE TABLE … );" 块。
func createBlocks(sql string) []string {
	const marker = "CREATE TABLE "
	var out []string
	for i := strings.Index(sql, marker); i >= 0; i = strings.Index(sql, marker) {
		rest := sql[i:]
		end := strings.Index(rest, "\n);")
		if end < 0 {
			break
		}
		block := rest[:end+3]
		out = append(out, block)
		sql = sql[i+len(block):]
	}
	return out
}

type serviceOpts struct {
	q     reward.Queue
	users reward.UserLookup
	set   reward.Settings
	audit reward.Auditor
	clk   clock.Clock
}

// svc 每次现建：依赖全是假件，没有需要复用的状态。
func (h *harness) svc(mut ...func(*serviceOpts)) *reward.Service {
	o := serviceOpts{q: h.queue, users: h.users, set: h.set, audit: h.audit, clk: h.clk}
	for _, f := range mut {
		f(&o)
	}
	return reward.NewService(h.db, o.q, o.users, o.set, o.audit, o.clk,
		slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})))
}

// svcNoAudit 用一个必然报错的审计假的实现换掉真的，验事务回滚。
func (h *harness) svcFailingQueue() *reward.Service {
	return h.svc(func(o *serviceOpts) { o.q = &fakeQueue{failNext: true} })
}

// newUser 建一个真用户并登记进假的 UserLookup。
func (h *harness) newUser(handle string) user {
	h.t.Helper()
	publicID := uuid.New()
	var id int64
	err := h.pool.QueryRow(h.ctx,
		`INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
		 VALUES ($1, $2, $3, 'x', $4, $5) RETURNING id`,
		publicID, handle, handle+"@example.com", handle, h.roleID).Scan(&id)
	if err != nil {
		h.t.Fatalf("建用户 %s: %v", handle, err)
	}
	b := reward.UserBasic{
		PublicID: publicID.String(),
		Handle:   handle,
		Nickname: strings.ToUpper(handle[:1]) + handle[1:],
		Status:   "active",
	}
	h.users.byID[id] = b
	h.users.byHandle[handle] = id
	return user{ID: id, Handle: handle, Basic: b}
}

// actor 造一个带权限点的 Actor。
func (h *harness) actor(u user, perms ...string) *authz.Actor {
	return &authz.Actor{UserID: u.ID, PublicID: u.Basic.PublicID, Perms: authz.NewSet(perms...), Status: "active"}
}

func (h *harness) adminActor() *authz.Actor { return h.actor(h.admin, authz.PermRewardVerify) }

// newChannel 给某人加一张收款码（images 行要先有）。
func (h *harness) newChannel(u user, label string) (publicID string, id int64) {
	h.t.Helper()
	hash := hex.EncodeToString(bytesOf(h.t, 32))
	if _, err := h.pool.Exec(h.ctx,
		`INSERT INTO images (hash, size, mime, owner_id, visibility) VALUES ($1, 1, 'image/png', $2, 2)`,
		hash, u.ID); err != nil {
		h.t.Fatalf("建图片: %v", err)
	}
	// public_id 列由 patchMigration 补上（0010 的 DDL 缺它）
	pid := uuid.New()
	if err := h.pool.QueryRow(h.ctx,
		`INSERT INTO payment_channels (public_id, user_id, label, image_hash, sort)
		 VALUES ($1, $2, $3, $4, 0) RETURNING id`, pid, u.ID, label, hash).Scan(&id); err != nil {
		h.t.Fatalf("建收款码: %v", err)
	}
	return pid.String(), id
}

// newTopic 建一个属于 author 的可见帖子。
func (h *harness) newTopic(author user) (publicID string, id int64) {
	h.t.Helper()
	pid := uuid.New()
	if err := h.pool.QueryRow(h.ctx,
		`INSERT INTO topics (public_id, board_id, author_id, title) VALUES ($1, $2, $3, 't') RETURNING id`,
		pid, h.boardID, author.ID).Scan(&id); err != nil {
		h.t.Fatalf("建帖子: %v", err)
	}
	return pid.String(), id
}

// donation 直接落一行申报，省去走 service 的样板。
func (h *harness) donation(donor, recipient user, cents int64, state string) (publicID string, id int64) {
	h.t.Helper()
	pid := uuid.New()
	// 手工夹具直接落终态：ck_donation_records_verified 要求 approved/rejected 必须带核验人与核验时间
	err := h.pool.QueryRow(h.ctx,
		`INSERT INTO donation_records (public_id, donor_id, recipient_id, amount_cents, state, verified_by, verified_at)
		 VALUES ($1, $2, $3, $4, $5,
		         CASE WHEN $5 IN ('approved','rejected') THEN $2::bigint ELSE NULL::bigint END,
		         CASE WHEN $5 IN ('approved','rejected') THEN now() ELSE NULL END) RETURNING id`,
		pid, donor.ID, recipient.ID, cents, state).Scan(&id)
	if err != nil {
		h.t.Fatalf("建申报: %v", err)
	}
	return pid.String(), id
}

func (h *harness) state(id int64) string {
	h.t.Helper()
	var s string
	if err := h.pool.QueryRow(h.ctx, `SELECT state FROM donation_records WHERE id = $1`, id).Scan(&s); err != nil {
		h.t.Fatalf("读状态: %v", err)
	}
	return s
}

func (h *harness) scalar(sqlText string, args ...any) int64 {
	h.t.Helper()
	var n int64
	if err := h.pool.QueryRow(h.ctx, sqlText, args...).Scan(&n); err != nil {
		h.t.Fatalf("标量查询 %q: %v", sqlText, err)
	}
	return n
}

// setUser 写一个人的展示开关。
func (h *harness) setUser(u user, show, public bool) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx,
		`INSERT INTO user_donation_settings (user_id, show_channels, records_public) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE SET show_channels = EXCLUDED.show_channels, records_public = EXCLUDED.records_public`,
		u.ID, show, public); err != nil {
		h.t.Fatalf("写展示开关: %v", err)
	}
}

func bytesOf(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// ---- 假依赖：本模块只认 deps.go 的小接口 ----

type fakeUsers struct {
	byID     map[int64]reward.UserBasic
	byHandle map[string]int64
}

func (f *fakeUsers) IDByHandle(_ context.Context, handle string) (int64, error) {
	id, ok := f.byHandle[handle]
	if !ok {
		return 0, errTest("no such user")
	}
	return id, nil
}

func (f *fakeUsers) Basic(_ context.Context, userID int64) (reward.UserBasic, error) {
	b, ok := f.byID[userID]
	if !ok {
		return reward.UserBasic{}, errTest("no such user")
	}
	return b, nil
}

type fakeSettings struct{ values map[string]string }

func (f *fakeSettings) Setting(_ context.Context, key string) string { return f.values[key] }

type fakeAudit struct {
	mu      sync.Mutex
	entries []reward.AuditEntry
}

func (f *fakeAudit) Write(_ context.Context, _ *ent.Tx, e reward.AuditEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries = append(f.entries, e)
	return nil
}

func (f *fakeAudit) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.entries)
}

func (f *fakeAudit) last() reward.AuditEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.entries[len(f.entries)-1]
}

// fakeQueue 只记任务类型；failNext 用来验「入队失败 → 整批回滚」。
type fakeQueue struct {
	mu       sync.Mutex
	tasks    []string
	failNext bool
}

func (f *fakeQueue) EnqueueTx(_ context.Context, _ *ent.Tx, task queue.Task) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext {
		return errTest("queue down")
	}
	f.tasks = append(f.tasks, task.Type)
	return nil
}

func (f *fakeQueue) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.tasks)
}

type errTest string

func (e errTest) Error() string { return string(e) }
