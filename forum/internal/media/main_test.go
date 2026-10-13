package media_test

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io/fs"
	"log/slog"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/media"
	"forum/internal/platform/clock"
	mediaimage "forum/internal/platform/image"
	"forum/internal/platform/image/localstore"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

type harness struct {
	t    *testing.T
	ctx  context.Context
	db   *ent.Client
	pool *pgxpool.Pool
	svc  *media.Service
	clk  *clock.Fake
	root string

	roleID  int64
	boardID int64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, base := testsupport.Pool(t)
	schema := base.Config().ConnConfig.RuntimeParams["search_path"]
	if schema == "" {
		t.Fatal("testsupport 的池没有 search_path")
	}

	// 迁移文件是一文件多语句：必须走简单协议，扩展协议下 pgx 会拒收。
	// 不这么做时报的是「对表 x 指定多个主键是不允许的」，与真实原因毫无关系。
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

	pool, err := pgxpool.ParseConfig(testsupport.DSN())
	if err != nil {
		t.Fatal(err)
	}
	pool.ConnConfig.RuntimeParams["search_path"] = schema
	rpool, err := pgxpool.NewWithConfig(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rpool.Close)

	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(rpool))))
	t.Cleanup(func() { _ = client.Close() })

	h := &harness{
		t: t, ctx: ctx, db: client, pool: rpool, root: t.TempDir(),
		clk: &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)},
	}
	store, err := localstore.New(h.root, 0)
	if err != nil {
		t.Fatal(err)
	}
	h.svc = media.NewService(media.Config{AvatarMax: 64 << 10, PostMax: 2 << 20, PaymentMax: 512 << 10},
		client, store, h.clk, quietLogger())
	if err := rpool.QueryRow(ctx, "SELECT id FROM roles ORDER BY id LIMIT 1").Scan(&h.roleID); err != nil {
		t.Fatalf("读角色: %v", err)
	}
	if err := rpool.QueryRow(ctx, "INSERT INTO boards (slug, name) VALUES ('general','综合') RETURNING id").Scan(&h.boardID); err != nil {
		t.Fatalf("建分区: %v", err)
	}
	return h
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// applyMigrations 跑全部 *.up.sql，并修补三处**已确认的迁移缺陷**（migrations/** 不在本模块作用域，
// 所以只能在测试里做等价修补；迁移被正式修好后这里整段删掉）：
//
//  1. 0004 的 board_acls / topic_images 同时写了 id 主键与表级复合主键 → PostgreSQL 42P16，
//     迁移在 0004 就断，后面一张表都建不出来。保留每个块里第一个主键，其余降成 UNIQUE。
//  2. 0010 的 payment_channels 缺 public_id（ent 的 PaymentChannel 带 mixin.PublicID，
//     生成代码的 SELECT 固定带它）→ 补上，与 reward 的测试补法一致。
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

// countFiles 数磁盘上的真图片文件（Walk 只认 64 位小写 hex 的名字）。
func (h *harness) countFiles() int {
	h.t.Helper()
	store, err := localstore.New(h.root, 0)
	if err != nil {
		h.t.Fatal(err)
	}
	n := 0
	if err := store.Walk(h.ctx, func(mediaimage.Hash) error { n++; return nil }); err != nil {
		h.t.Fatal(err)
	}
	return n
}

type user struct {
	ID       int64
	PublicID string
	Handle   string
}

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
	return user{ID: id, PublicID: publicID.String(), Handle: handle}
}

func (h *harness) actor(u user, perms ...string) *authz.Actor {
	return &authz.Actor{
		UserID: u.ID, PublicID: u.PublicID, Perms: authz.NewSet(perms...),
		Status: "active", Activated: true,
	}
}

// newTopic 建一个主题 + 它的 1 楼（配图挂在楼层上）。
func (h *harness) newTopic(author user, visibility string) (string, int64) {
	h.t.Helper()
	var id int64
	pid := uuid.New()
	if err := h.pool.QueryRow(h.ctx,
		`INSERT INTO topics (public_id, board_id, author_id, title, visibility)
		 VALUES ($1, $2, $3, '标题', $4) RETURNING id`,
		pid, h.boardID, author.ID, visibility).Scan(&id); err != nil {
		h.t.Fatalf("建主题: %v", err)
	}
	if _, err := h.pool.Exec(h.ctx,
		`INSERT INTO posts (public_id, topic_id, author_id, floor, content_md, content_html)
		 VALUES ($1, $2, $3, 1, 'x', '<p>x</p>')`, uuid.New(), id, author.ID); err != nil {
		h.t.Fatalf("建 1 楼: %v", err)
	}
	return pid.String(), id
}

func (h *harness) scalar(query string, args ...any) int64 {
	h.t.Helper()
	var n int64
	if err := h.pool.QueryRow(h.ctx, query, args...).Scan(&n); err != nil {
		h.t.Fatalf("标量查询 %q: %v", query, err)
	}
	return n
}

func (h *harness) text(query string, args ...any) string {
	h.t.Helper()
	var s string
	if err := h.pool.QueryRow(h.ctx, query, args...).Scan(&s); err != nil {
		h.t.Fatalf("查询 %q: %v", query, err)
	}
	return s
}

// pngBytes 现画一张 w×h 的 PNG（四种格式里最简单的一种）。
func pngBytes(t *testing.T, w, h int, c color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
