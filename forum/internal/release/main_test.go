package release_test

import (
	"context"
	"io/fs"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/clock"
	"forum/internal/release"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

type harness struct {
	t    *testing.T
	ctx  context.Context
	db   *ent.Client
	pool *pgxpool.Pool
	svc  *release.Service
	clk  *clock.Fake
	ctr  *fakeCounter
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, base := testsupport.Pool(t)
	schema := base.Config().ConnConfig.RuntimeParams["search_path"]
	if schema == "" {
		t.Fatal("testsupport 的池没有 search_path")
	}
	mcfg, err := pgxpool.ParseConfig(testsupport.DSN())
	if err != nil {
		t.Fatal(err)
	}
	mcfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	mcfg.ConnConfig.RuntimeParams["search_path"] = schema
	mpool, err := pgxpool.NewWithConfig(ctx, mcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mpool.Close)
	applyMigrations(t, ctx, mpool)

	pcfg, err := pgxpool.ParseConfig(testsupport.DSN())
	if err != nil {
		t.Fatal(err)
	}
	pcfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })

	h := &harness{
		t: t, ctx: ctx, db: client, pool: pool,
		clk: &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)},
		ctr: &fakeCounter{},
	}
	h.svc = release.NewService(client, h.ctr, h.clk,
		slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1})))
	return h
}

// applyMigrations 跑全部 *.up.sql，修补 0004 的两处重复主键（PostgreSQL 42P16 会让迁移在 0004 断，
// 之后一张表都建不出来）。migrations/** 不在本模块作用域，所以只在测试里做等价修补。
func applyMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
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
		var b strings.Builder
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "--") {
				continue
			}
			b.WriteString(line)
			b.WriteByte('\n')
		}
		sql := b.String()
		sql = strings.Replace(sql, "CREATE TABLE payment_channels (\n",
			"CREATE TABLE payment_channels (\n  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,\n", 1)
		if _, err := pool.Exec(ctx, demoteExtraPrimaryKeys(sql)); err != nil {
			t.Fatalf("迁移 %s: %v", name, err)
		}
	}
}

// demoteExtraPrimaryKeys 把每个 CREATE TABLE 块里第二个及以后的主键降成 UNIQUE（唯一性不变）。
// 按块文本做替换：块内容唯一，不需要维护搜索位置（第一版在这里写出了死循环）。
func demoteExtraPrimaryKeys(sql string) string {
	for _, block := range createBlocks(sql) {
		if strings.Count(block, "PRIMARY KEY") < 2 {
			continue
		}
		seen := false
		fixed := strings.Split(block, "\n")
		for j, ln := range fixed {
			if !strings.Contains(ln, "PRIMARY KEY") {
				continue
			}
			if seen {
				fixed[j] = strings.Replace(ln, "PRIMARY KEY", "UNIQUE", 1)
			}
			seen = true
		}
		sql = strings.Replace(sql, block, strings.Join(fixed, "\n"), 1)
	}
	return sql
}

// createBlocks 切出每个完整的 CREATE TABLE 块（到第一个 "\n);" 为止）。
func createBlocks(sql string) []string {
	const marker = "CREATE TABLE "
	var out []string
	for {
		i := strings.Index(sql, marker)
		if i < 0 {
			return out
		}
		rest := sql[i:]
		end := strings.Index(rest, "\n);")
		if end < 0 {
			return out
		}
		block := rest[:end+3]
		out = append(out, block)
		sql = rest[len(block):]
	}
}

// adminActor 持 site.setting（管理端四条路由的权限点，21.2 没有更细的）。
func (h *harness) adminActor() *authz.Actor {
	return &authz.Actor{UserID: 1, Perms: authz.NewSet(authz.PermSiteSetting), Status: "active", Activated: true}
}

func (h *harness) plainActor() *authz.Actor {
	return &authz.Actor{UserID: 2, Perms: authz.NewSet(), Status: "active", Activated: true}
}

// publish 走真实路径：录草稿 → 加一个产物 → 置 published。
func (h *harness) publish(version string, at time.Time) string {
	h.t.Helper()
	actor := h.adminActor()
	rel, err := h.svc.UpsertRelease(h.ctx, actor, release.UpsertReleaseInput{
		Version: version, Channel: release.ChannelStable, NotesMD: "更新说明", NotesHTML: "<p>更新说明</p>",
	})
	if err != nil {
		h.t.Fatalf("录版本 %s: %v", version, err)
	}
	if _, err := h.svc.UpsertAsset(h.ctx, actor, release.UpsertAssetInput{
		ReleaseID: rel.ID, Platform: "windows", Arch: "x86_64",
		URL: "https://example.com/sc2clud-" + version + ".zip", SHA256: strings.Repeat("a", 64), Size: 1024,
	}); err != nil {
		h.t.Fatalf("加产物 %s: %v", version, err)
	}
	h.clk.T = at
	if err := h.svc.SetReleaseStatus(h.ctx, actor, release.SetReleaseStatusInput{ID: rel.ID, Status: release.StatusPublished}); err != nil {
		h.t.Fatalf("发布 %s: %v", version, err)
	}
	return rel.ID
}

func (h *harness) scalar(query string, args ...any) int64 {
	h.t.Helper()
	var n int64
	if err := h.pool.QueryRow(h.ctx, query, args...).Scan(&n); err != nil {
		h.t.Fatalf("标量查询 %q: %v", query, err)
	}
	return n
}

// text 读一个字符串列。
func (h *harness) text(query string, args ...any) string {
	h.t.Helper()
	var v string
	if err := h.pool.QueryRow(h.ctx, query, args...).Scan(&v); err != nil {
		h.t.Fatalf("查询 %q: %v", query, err)
	}
	return v
}

// textTime 读一个 timestamptz。
func (h *harness) textTime(query string, args ...any) time.Time {
	h.t.Helper()
	var ts time.Time
	if err := h.pool.QueryRow(h.ctx, query, args...).Scan(&ts); err != nil {
		h.t.Fatalf("查询 %q: %v", query, err)
	}
	return ts.UTC()
}

// itoa 让测试不必到处 import strconv。
func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// fakeCounter 只记账：请求路径上加内存，不碰数据库。
type fakeCounter struct {
	keys []string
}

func (f *fakeCounter) Add(key string, delta int64) {
	if delta == 0 {
		return
	}
	f.keys = append(f.keys, key)
}
