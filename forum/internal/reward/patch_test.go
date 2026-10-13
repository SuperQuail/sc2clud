package reward_test

import (
	"io/fs"
	"os"
	"strings"
	"testing"

	"forum/internal/testsupport"
)

// TestMigrationPatchInvariants 是 harness 补丁的自检：补完之后每张表最多一个主键。
func TestMigrationPatchInvariants(t *testing.T) {
	dir := testsupport.MigrationsDir()
	for _, name := range []string{"0004_forum.up.sql", "0010_media.up.sql", "0011_reward.up.sql"} {
		out := patchMigration(readMigration(t, dir, name))
		for _, block := range createBlocks(out) {
			if n := strings.Count(block, "PRIMARY KEY"); n > 1 {
				head, _, _ := strings.Cut(block, "\n")
				t.Fatalf("%s: %s 仍有 %d 个主键\n%s", name, head, n, block)
			}
		}
	}
}

// TestPatchIsIdempotent 保证补丁不会重复插列（迁移被正式修好后它退化成空操作）。
func TestPatchIsIdempotent(t *testing.T) {
	dir := testsupport.MigrationsDir()
	media := readMigration(t, dir, "0010_media.up.sql")
	once := patchMigration(media)
	twice := patchMigration(once)
	if once != twice {
		t.Fatal("补丁必须幂等：跑两次的结果不一致")
	}
	if !strings.Contains(once, "public_id") {
		t.Fatal("0010 的 payment_channels 应当被补上 public_id")
	}
}

func TestPatchLeavesGoodMigrationsAlone(t *testing.T) {
	dir := testsupport.MigrationsDir()
	reward := readMigration(t, dir, "0011_reward.up.sql")
	if got := patchMigration(reward); got != reward {
		t.Fatal("0011 已经对了，补丁不该改动它")
	}
}

func readMigration(t *testing.T, dir, name string) string {
	t.Helper()
	raw, err := fs.ReadFile(os.DirFS(dir), name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
