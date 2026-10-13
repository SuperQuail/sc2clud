package audit_test

import (
	"context"
	"fmt"
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
	"forum/internal/platform/audit"
	"forum/internal/platform/clock"
	"forum/internal/platform/db"
	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

// newDB 起一个跑过全部手写迁移的库 + ent 客户端。
// audit_logs 只存在于迁移里（ent schema 表达不了 inet 与三条 DESC 索引），所以必须先跑迁移。
func newDB(t *testing.T) (context.Context, *ent.Client, *pgxpool.Pool) {
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

	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	t.Cleanup(func() { _ = client.Close() })
	return ctx, client, pool
}

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
		// 0004 的 board_acls / topic_images 同时写了 id 主键与表级复合主键 → 42P16。
		// 那不是本包的东西；改成等价 UNIQUE 让夹具建得起来（同一处也会让 forum migrate 红）。
		sql := demoteExtraPrimaryKeys(sb.String())
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatalf("迁移 %s: %v", name, err)
		}
	}
}

// pkConflict 命中迁移文件里的**表级** PRIMARY KEY 行（见 applyMigrations 的说明）。
var pkConflict = regexp.MustCompile(`(?m)^[ \t]*PRIMARY KEY \(([^)]*)\),[ \t]*$`)

// demoteExtraPrimaryKeys 把表级复合主键降成等价的 UNIQUE。
// 只动「行首的 PRIMARY KEY (...) ,」这一种形状：列级的 id ... PRIMARY KEY 不受影响。
func demoteExtraPrimaryKeys(sql string) string {
	return pkConflict.ReplaceAllString(sql, "UNIQUE ($1),")
}

func newUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) int64 {
	t.Helper()
	key := strings.ReplaceAll(uuid.NewString(), "-", "")[:20]
	if _, err := pool.Exec(ctx, "INSERT INTO roles (key, name, is_system) VALUES ($1, $1, true)", key); err != nil {
		t.Fatalf("建角色: %v", err)
	}
	var id int64
	err := pool.QueryRow(ctx, `
INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
VALUES ($1, $2, $3, $4, $5, (SELECT id FROM roles WHERE key = $6))
RETURNING id`, uuid.NewString(), name, name+"@t", "x", name, key).Scan(&id)
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	return id
}

func count(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM audit_logs").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// 拍板 §5.4 / d6 §1.1：审计必须与业务同事务——回滚后审计行也不许留下。
func TestAuditRollsBackWithBusiness(t *testing.T) {
	ctx, client, pool := newDB(t)
	uid := newUser(t, ctx, pool, "alice")
	w := audit.New(client, &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)})

	err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
		if err := w.Write(ctx, tx, audit.Entry{
			ActorID: uid, Action: "role.grant", TargetType: "user", TargetID: uuid.NewString(),
			Detail: map[string]any{"before": map[string]any{"role": "member"}, "after": map[string]any{"role": "admin"}},
			IP:     "203.0.113.7",
		}); err != nil {
			return err
		}
		return fmt.Errorf("业务失败：整条事务必须回滚")
	})
	if err == nil {
		t.Fatal("事务里的错误必须冒出来")
	}
	if n := count(t, ctx, pool); n != 0 {
		t.Fatalf("业务回滚后审计行也不许留下，实际留下 %d 行", n)
	}

	if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
		return w.Write(ctx, tx, audit.Entry{ActorID: uid, Action: "role.grant", TargetType: "user", TargetID: uuid.NewString()})
	}); err != nil {
		t.Fatal(err)
	}
	if n := count(t, ctx, pool); n != 1 {
		t.Fatalf("提交后应当恰好 1 行，实际 %d", n)
	}
}

// ip 是 inet、detail 是 jsonb：走原生 SQL 才能写进去（ent 侧 ip 是 varchar）。
func TestWriteStoresInetAndJSONB(t *testing.T) {
	ctx, client, pool := newDB(t)
	uid := newUser(t, ctx, pool, "bob")
	w := audit.New(client, &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)})
	id := uuid.NewString()

	var batchErr error
	if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
		batchErr = w.WriteBatch(ctx, tx, []audit.Entry{
			{ActorID: uid, Action: "site.setting.update", TargetType: "site", TargetID: "auth.registration.auto_activate", Detail: map[string]any{"after": true}, IP: "198.51.100.9"},
			{Action: "mail.account.archive", TargetType: "mail_account", TargetID: id},
		})
		return batchErr
	}); err != nil {
		t.Fatal(err)
	}

	var (
		ip     *string
		action string
		detail string
	)
	err := pool.QueryRow(ctx, `SELECT host(ip), action, detail::text FROM audit_logs
		 WHERE target_id = $1 ORDER BY id`, "auth.registration.auto_activate").Scan(&ip, &action, &detail)
	if err != nil {
		t.Fatal(err)
	}
	if ip == nil || *ip != "198.51.100.9" {
		t.Fatalf("inet 没写进去: %v", ip)
	}
	if action != "site.setting.update" || !strings.Contains(detail, "true") {
		t.Fatalf("action/detail 不对: %s %s", action, detail)
	}

	// 第二条：actor 与 ip 都是 NULL，detail 是空对象（而不是 NULL）。
	var (
		nilActor *int64
		nilIP    *string
		nilDet   string
	)
	err = pool.QueryRow(ctx, "SELECT actor_id, ip, detail::text FROM audit_logs WHERE target_id = $1", id).
		Scan(&nilActor, &nilIP, &nilDet)
	if err != nil {
		t.Fatal(err)
	}
	if nilActor != nil || nilIP != nil || nilDet != "{}" {
		t.Fatalf("NULL/空 detail 处理不对: actor=%v ip=%v detail=%s", nilActor, nilIP, nilDet)
	}
}

// 空 action/target 会在 PG 那一层失败（NOT NULL + CHECK），但那时离调用点已经很远；
// 写入器自己先拦，错误里带上出问题的字段。
func TestRejectsEmptyRequiredFields(t *testing.T) {
	ctx, client, _ := newDB(t)
	w := audit.New(client, &clock.Fake{T: time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)})
	if err := db.WithTx(ctx, client, func(tx *ent.Tx) error {
		return w.Write(ctx, tx, audit.Entry{Action: "x", TargetType: "user"})
	}); err == nil {
		t.Fatal("target_id 为空必须报错")
	}
}
