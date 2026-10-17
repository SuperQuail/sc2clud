package mail

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
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

	ent "forum/internal/ent"
	"forum/internal/platform/clock"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

const testKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

var ctxBG = context.Background()

// harness 是一个跑过全部迁移的真库 + 一个 Router。
// provider 被替换成 fakeProvider：测的是 Router 的额度与换账号逻辑，不是 HTTP。
type harness struct {
	t     *testing.T
	ctx   context.Context
	pool  *pgxpool.Pool
	db    *ent.Client
	r     *Router
	clk   *clock.Fake
	store *fakeStore
	prov  *fakeProvider
	crypt *Crypter
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, base := testsupport.Pool(t)
	schema := base.Config().ConnConfig.RuntimeParams["search_path"]
	if schema == "" {
		t.Fatal("testsupport 的池没有 search_path")
	}
	// 迁移文件一个文件多条语句：扩展协议下 pgx 拒收，必须走简单协议。
	cfg, err := pgxpool.ParseConfig(testsupport.DSN())
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	applyMigrations(t, ctx, pool)

	db := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = db.Close() })

	crypt, err := NewCrypter(testKey)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		t: t, ctx: ctx, pool: pool, db: db, crypt: crypt,
		clk:   &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)},
		store: &fakeStore{},
		prov:  &fakeProvider{},
	}
	h.r = NewRouter(Dependencies{
		DB: db, Crypter: crypt, Store: h.store, Clock: h.clk,
		Log:      slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1})),
		CacheTTL: 0, // 测试里不要缓存：每个用例都改账号
	})
	h.r.providerFn = func(Account) (Provider, error) { return h.prov, nil }
	return h
}

// newAccount 建一个可用账号。priority 越大越优先；dailyLimit 是每天额度。
func (h *harness) newAccount(name, provider string, priority, dailyLimit int, tz string) int64 {
	h.t.Helper()
	publicID := uuid.NewString()
	secret, nonce, err := h.crypt.Encrypt([]byte(`{"api_key":"k"}`), []byte(publicID))
	if err != nil {
		h.t.Fatal(err)
	}
	var id int64
	err = h.pool.QueryRow(h.ctx, `
INSERT INTO mail_accounts (public_id, name, provider, priority, daily_limit, reset_tz,
                           from_address, options_json, secret_cipher, secret_nonce)
VALUES ($1, $2, $3, $4, $5, $6, 'no-reply@example.com', '{}'::jsonb, $7, $8)
RETURNING id`, publicID, name, provider, priority, dailyLimit, tz, secret, nonce).Scan(&id)
	if err != nil {
		h.t.Fatalf("建账号 %s: %v", name, err)
	}
	return id
}

// quotaCount 读某个账号某一天的额度计数（读不到返回 0）。
func (h *harness) quotaCount(accountID int64, day string) int {
	h.t.Helper()
	var n int
	err := h.pool.QueryRow(h.ctx,
		"SELECT count FROM mail_quota WHERE account_id = $1 AND day = $2::date", accountID, day).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0
	}
	if err != nil {
		h.t.Fatalf("读额度: %v", err)
	}
	return n
}

// fakeStore 记录 Router 写回的额度与健康状态。
type fakeStore struct {
	bound []string // "<accountID>@<day>"
	last  error    // 最近一次 Report 的错误（nil = 成功）
	oks   int
}

func (s *fakeStore) BindQuota(_ context.Context, accountID int64, day string) error {
	s.bound = append(s.bound, fmt.Sprintf("%d@%s", accountID, day))
	return nil
}

func (s *fakeStore) Report(_ context.Context, _ int64, err error) error {
	s.last = err
	if err == nil {
		s.oks++
	}
	return nil
}

// fakeProvider 按脚本返回多次投递的结果，并记录每次用的是哪个账号。
type fakeProvider struct {
	errs []error // 依次返回；用完后一律返回 nil
	n    int
}

func (f *fakeProvider) Send(_ context.Context, _ Message) error {
	f.n++
	if len(f.errs) == 0 {
		return nil
	}
	err := f.errs[0]
	f.errs = f.errs[1:]
	return err
}

// pkConflict 命中迁移文件里的**表级** PRIMARY KEY 行（见 applyMigrations 的说明）。
var pkConflict = regexp.MustCompile("(?m)^[ \\t]*PRIMARY KEY \\(([^)]*)\\),[ \\t]*$")

// applyMigrations 顺序执行 migrations/postgres/*.up.sql。
// 不用 golang-migrate：它把版本记在固定表名的 schema_migrations 上，每个用例独立 schema 会互相踩。
func applyMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
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
		var sb strings.Builder
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "--") {
				continue // 只去纯注释行：行内注释属于 SQL 文本
			}
			sb.WriteString(line)
			sb.WriteByte(10)
		}
		// 0004 的 board_acls / topic_images 同时写了 id 主键与表级复合主键 → 42P16；
		// 那不是本包的东西，改成等价 UNIQUE 让夹具建得起来。
		if _, err := pool.Exec(ctx, pkConflict.ReplaceAllString(sb.String(), "UNIQUE ($1),")); err != nil {
			t.Fatalf("迁移 %s: %v", name, err)
		}
	}
}
