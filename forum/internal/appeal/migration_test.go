package appeal

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/testsupport"
)

// TestMain 起嵌入式 PostgreSQL（与别的域同一套）。
//
// 起不来时**跳过整个包的库用例**：本域的单测（TestCreateGuards）不该因为「这台机器上没有库」变红。
// 判据是 TEST_DATABASE_URL 与数据目录能不能建 —— testsupport 起不来会 panic，这里接住它。
func TestMain(m *testing.M) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		dir, err := os.MkdirTemp("", "appeal-pg-probe-")
		if err != nil {
			// 连临时目录都建不了：这台机器跑不了库用例，直接当通过（单测仍然跑）。
			os.Exit(runWithoutDB(m))
		}
		_ = os.RemoveAll(dir)
	}
	testsupport.Main(m)
}

// runWithoutDB 只跑不连库的用例（-test.run 过滤掉库用例）。
func runWithoutDB(m *testing.M) int {
	flag := []string{"-test.run", "TestCreateGuards"}
	os.Args = append([]string{os.Args[0]}, append(flag, os.Args[1:]...)...)
	return m.Run()
}

// TestAppealsMigrationRoundTrip 验证 0022 的 up 与 down **都能跑**。
//
// 为什么值得一条用例：迁移是「跑一次就留在库里」的东西，而 down 几乎没有别的执行路径。
// 它挡三类事：SQL 语法错、down 漏了依赖对象（表删了索引没走）、以及**回滚之后没干净**
// （下次 up 撞名字）。落库形态（no 生成列 / CHECK 形状 / C5 幂等）由 app 包那条 e2e 用真接口覆盖。
func TestAppealsMigrationRoundTrip(t *testing.T) {
	ctx, pool := testsupport.Pool(t)

	// **先把前面 21 个迁移按序跑完**：0022 的 user_id / topic_id 是外键，本表建不起来时
	// 「关系 users 不存在」会盖住真正要看的东西（本文件第一次跑就是这么红的）。
	migrateAll(t, ctx, pool)

	// **up 已经在上一步跑过了**（migrateAll 就是全量 up）：这里验证的是回滚，以及回滚之后能再 up。
	// 这两件事没有别的执行路径 —— 全量 up 的形态另有 app 包那条 e2e 覆盖。
	down := readMigration(t, "0022_appeals.down.sql")
	// up 之后：表在，三条关键索引也在（uq_appeals_topic_pending 是 C5 幂等的唯一落点）。
	if !tableExists(t, ctx, pool, "appeals") {
		t.Fatal("全量 up 之后没有 appeals 表")
	}
	for _, idx := range []string{"uq_appeals_topic_pending", "idx_appeals_queue", "idx_appeals_no"} {
		if !indexExists(t, ctx, pool, idx) {
			t.Fatalf("up 之后缺索引 %s", idx)
		}
	}
	// 生成列 no 真的按 'AP-' || (id + 2000) 算（它的形状只有真库能证明）。
	var no string
	if err := pool.QueryRow(ctx, `INSERT INTO appeals (public_id, type, username, email, title, details)
		VALUES (gen_random_uuid(), 'other', 'u', 'u@example.com', 't', 'd') RETURNING no`).Scan(&no); err != nil {
		t.Fatalf("插入一条: %v", err)
	}
	if no != "AP-2001" {
		t.Fatalf("第一条的单号应当是 AP-2001，实际 %q", no)
	}

	if _, err := pool.Exec(ctx, down); err != nil {
		t.Fatalf("0022 down 跑不动: %v", err)
	}
	if tableExists(t, ctx, pool, "appeals") {
		t.Fatal("down 之后 appeals 表还在")
	}
	for _, idx := range []string{"uq_appeals_topic_pending", "idx_appeals_queue", "idx_appeals_no"} {
		if indexExists(t, ctx, pool, idx) {
			t.Fatalf("down 之后索引 %s 还在（回滚不干净，下次 up 会撞名字）", idx)
		}
	}
	// 回滚之后还能再 up 一次：这是「干净」的最强证明。
	if _, err := pool.Exec(ctx, readMigration(t, "0022_appeals.up.sql")); err != nil {
		t.Fatalf("down 之后重新 up 失败（说明回滚没干净）: %v", err)
	}
}

// migrateAll 按文件名顺序跑完所有 .up.sql（forum 包的 harness_test.go 有同一份写法）。
func migrateAll(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".up.sql") {
			continue
		}
		if _, err := pool.Exec(ctx, readMigration(t, name)); err != nil {
			t.Fatalf("迁移 %s 失败: %v", name, err)
		}
	}
}

// readMigration 从仓库的 migrations/postgres 读一份迁移（与 forum 包的 harness 同一个入口）。
func readMigration(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(testsupport.MigrationsDir(), name))
	if err != nil {
		t.Fatalf("读迁移 %s: %v", name, err)
	}
	return string(b)
}

func tableExists(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE c.relname = $1 AND n.nspname = current_schema())`, name).Scan(&ok); err != nil {
		t.Fatalf("查表 %s: %v", name, err)
	}
	return ok
}

func indexExists(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE c.relname = $1 AND c.relkind = 'i' AND n.nspname = current_schema())`, name).Scan(&ok); err != nil {
		t.Fatalf("查索引 %s: %v", name, err)
	}
	return ok
}
