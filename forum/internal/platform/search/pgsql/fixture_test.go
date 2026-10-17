package pgsql

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/ent"
	"forum/internal/platform/search"
	"forum/internal/testsupport"
)

// newTestDB 起一个带全部手写迁移的库。
//
// search 真正依赖的东西（topic_search 的生成列、GIN）只存在于迁移里，
// 用 ent 建表测不出生成列与 opclass 的问题，所以必须先跑迁移（拍板 §5.8）。
func newTestDB(t *testing.T) (context.Context, *ent.Client, *pgxpool.Pool) {
	t.Helper()
	ctx, base := testsupport.Pool(t)
	schema := base.Config().ConnConfig.RuntimeParams["search_path"]
	if schema == "" {
		t.Fatal("testsupport 的池没有 search_path")
	}
	// 迁移文件一个文件是多条语句；扩展协议下 pgx 拒绝多语句，必须走简单协议。
	// 不这么做时 PostgreSQL 报的是「对表 x 指定多个主键是不允许的」，与真实原因毫无关系。
	cfg, err := pgxpool.ParseConfig(testsupport.DSN())
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := applyMigrations(ctx, pool); err != nil {
		t.Fatalf("迁移: %v", err)
	}
	client := ent.NewClient(ent.Driver(entsql.OpenDB("postgres", stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })
	return ctx, client, pool
}

// pkConflict 命中迁移文件里的**表级** PRIMARY KEY 行（见 applyMigrations 的说明）。
var pkConflict = regexp.MustCompile(`(?m)^[ \t]*PRIMARY KEY \(([^)]*)\),[ \t]*$`)

// applyMigrations 顺序执行 migrations/postgres/*.up.sql。
// 不用 golang-migrate：它把版本号记在固定表名的 schema_migrations 上，每个用例独立 schema 会互相踩。
func applyMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
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
			return err
		}
		var sb strings.Builder
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "--") {
				continue // 只去纯注释行：行内注释属于 SQL 文本
			}
			sb.WriteString(line)
			sb.WriteByte('\n')
		}
		// 0004 的 board_acls / topic_images 同时写了 id PRIMARY KEY 与表级 PRIMARY KEY，
		// PostgreSQL 直接拒绝（42P16）。那不是本模块的东西，改成等价的 UNIQUE 让夹具建得起来。
		// 同一处也会让 forum migrate / CI 红：已写进回报，hack 只在本测试里。
		sql := pkConflict.ReplaceAllString(sb.String(), "UNIQUE ($1),")
		if _, err := pool.Exec(ctx, sql); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

// newUser 造一个用户（topics.author_id 非空且 RESTRICT，夹具必须真建用户）。
func newUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int64 {
	t.Helper()
	key := strings.ReplaceAll(uuid.NewString(), "-", "")[:20]
	if _, err := pool.Exec(ctx,
		"INSERT INTO roles (key, name, is_system) VALUES ($1, $1, true)", key); err != nil {
		t.Fatalf("建角色: %v", err)
	}
	var id int64
	if err := pool.QueryRow(ctx, `
INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
VALUES ($1, $2, $3, 'x', $2, (SELECT id FROM roles WHERE key = $2))
RETURNING id`, uuid.NewString(), key, key+"@t").Scan(&id); err != nil {
		t.Fatalf("建用户: %v", err)
	}
	return id
}

// newBoard 造一个分区。
func newBoard(t *testing.T, ctx context.Context, pool *pgxpool.Pool, slug string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx,
		"INSERT INTO boards (slug, name) VALUES ($1, $1) RETURNING id", slug).Scan(&id); err != nil {
		t.Fatalf("建分区: %v", err)
	}
	return id
}

// newTopic 造一个主题（visibility / review_state 由调用方给，测试拿它做可见性反例）。
func newTopic(t *testing.T, ctx context.Context, pool *pgxpool.Pool, boardID, authorID int64, title, visibility, reviewState string) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, `
INSERT INTO topics (public_id, board_id, author_id, title, visibility, review_state)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		uuid.NewString(), boardID, authorID, title, visibility, reviewState).Scan(&id)
	if err != nil {
		t.Fatalf("建主题: %v", err)
	}
	return id
}

// index 走**与生产同一条写路径**：tokens 由 search.Tokenize 算好再交给 Indexer。
func index(t *testing.T, ctx context.Context, s *Searcher, topicID int64, title, bodyText string) string {
	t.Helper()
	tokens := search.Tokenize(title + " " + bodyText)
	if err := s.UpsertTopic(ctx, search.TopicDoc{TopicID: topicID, Title: title, BodyText: bodyText, Tokens: tokens}); err != nil {
		t.Fatalf("写索引: %v", err)
	}
	return tokens
}
