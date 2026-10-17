package db

import (
	"context"
	"os"
	"testing"

	"forum/internal/testsupport"
)

func TestMain(m *testing.M) { testsupport.Main(m) }

func TestEnsureVersionRejectsUnmigrated(t *testing.T) {
	ctx, pool := testsupport.Pool(t)
	if err := EnsureVersion(ctx, pool, 1); err == nil {
		t.Fatal("没迁移过的库必须被拒绝启动")
	}
}

func TestMigrateWithEmptyDirFailsLoudly(t *testing.T) {
	if err := Migrate(context.Background(), testsupport.DSN(), os.DirFS(t.TempDir())); err == nil {
		t.Fatal("空的迁移目录必须报错，而不是静默成功")
	}
}

func TestForeignKeysWithoutIndexCheckIsRed(t *testing.T) {
	ctx, pool := testsupport.Pool(t)
	for _, s := range []string{
		"CREATE TABLE fk_parent (id bigint PRIMARY KEY)",
		"CREATE TABLE fk_child (id bigint PRIMARY KEY, parent_id bigint NOT NULL REFERENCES fk_parent(id))",
	} {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := SelfCheck(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("外键没有索引时自检必须报红（空库跑通不算验收）")
	}

	if _, err := pool.Exec(ctx, "CREATE INDEX fk_child_parent_idx ON fk_child (parent_id)"); err != nil {
		t.Fatal(err)
	}
	rows, err = SelfCheck(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("补上索引后不该再报，实际: %v", rows)
	}

	// 部分索引不算覆盖：RI 查找用不了它（indpred IS NULL 那条过滤的意义）
	if _, err := pool.Exec(ctx, "DROP INDEX fk_child_parent_idx"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "CREATE INDEX fk_child_parent_partial ON fk_child (parent_id) WHERE parent_id IS NOT NULL"); err != nil {
		t.Fatal(err)
	}
	rows, err = SelfCheck(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("部分索引必须被判定为「没有可用索引」")
	}
}
