// Package testsupport 是集成测试共用的真实 PostgreSQL 实例。
//
// 一个测试进程共享一个实例（TestMain 里起、退出停）；每个用例用独立 schema：
//
//	CREATE SCHEMA test_xxx; SET search_path TO test_xxx;
//
// 端口必须显式改成随机值——embedded-postgres 默认 5432，会撞上真库。
//
// 用法：
//
//	func TestMain(m *testing.M) { testsupport.Main(m) }
//	在用例里：ctx, pool := testsupport.Pool(t)   // 已建好独立 schema 的池
package testsupport

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	instance *embeddedpostgres.EmbeddedPostgres
	dsn      string
	schemaN  atomic.Int64
)

// Main 是测试进程的统一入口：起实例 → 跑用例 → 停实例。
func Main(m *testing.M) {
	if err := start(); err != nil {
		panic(err)
	}
	code := m.Run()
	stop()
	os.Exit(code)
}

// DSN 返回连接串。
func DSN() string {
	if dsn == "" {
		panic("testsupport: 先调 Main()")
	}
	return dsn
}

// Pool 开一个带独立 schema 的池，并把 search_path 固定到该 schema。
// 池里每个连接都会带上这个 search_path，所以用例里的 SQL 不需要写 schema 前缀。
func Pool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	schema := fmt.Sprintf("test_%d_%d", os.Getpid(), schemaN.Add(1))

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("testsupport: parse dsn: %v", err)
	}
	cfg.MaxConns = 12
	cfg.MinConns = 1
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	cfg.ConnConfig.RuntimeParams["search_path"] = schema

	// 先建 schema（用一条临时连接），再开池——这样池的第一个连接就能用上它
	setup, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("testsupport: pool: %v", err)
	}
	if _, err := setup.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		setup.Close()
		t.Fatalf("testsupport: create schema %s: %v", schema, err)
	}
	t.Cleanup(func() {
		_, _ = setup.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		setup.Close()
	})
	return ctx, setup
}

// MigrationsDir 返回仓库里迁移目录的绝对路径（测试工作目录是包目录，所以往上找）。
func MigrationsDir() string {
	dir, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	for i := 0; i < 8; i++ {
		cand := filepath.Join(dir, "migrations", "postgres")
		if st, err := os.Stat(cand); err == nil && st.IsDir() {
			return cand
		}
		dir = filepath.Dir(dir)
	}
	panic("testsupport: 找不到 migrations/postgres")
}

func start() error {
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		dsn = url
		return nil
	}
	dataDir, err := os.MkdirTemp("", "forum-pg-data-")
	if err != nil {
		return err
	}
	runDir, err := os.MkdirTemp("", "forum-pg-run-")
	if err != nil {
		return err
	}
	port := 20000 + rand.Intn(20000)
	instance = embeddedpostgres.NewDatabase(
		embeddedpostgres.DefaultConfig().
			Port(uint32(port)).
			DataPath(dataDir).
			RuntimePath(runDir).
			Username("forum").
			Password("forum").
			Database("forum_test"),
	)
	if err := instance.Start(); err != nil {
		return fmt.Errorf("testsupport: 启动嵌入式 PostgreSQL 失败: %w", err)
	}
	dsn = fmt.Sprintf("postgres://forum:forum@127.0.0.1:%d/forum_test?sslmode=disable", port)
	return nil
}

func stop() {
	if instance != nil {
		_ = instance.Stop()
		instance = nil
	}
}
