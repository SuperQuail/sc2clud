package reward_test

import (
	"io/fs"
	"os"
	"strings"
	"testing"

	"forum/internal/testsupport"
)

// TestMigrationPatchInvariants 是 harness 补丁的自检：
// 补完之后每张表最多一个主键，且三张缺列的表都拿到了 ent 生成代码要的列。
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

func TestPatchAddsMissingColumns(t *testing.T) {
	dir := testsupport.MigrationsDir()
	reward := patchMigration(readMigration(t, dir, "0011_reward.up.sql"))
	for _, want := range []string{
		"id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  user_id",
		"user_id        bigint       UNIQUE REFERENCES users(id)",
		"id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  channel",
	} {
		if !strings.Contains(reward, want) {
			t.Fatalf("0011 补丁缺少：%q", want)
		}
	}
	media := patchMigration(readMigration(t, dir, "0010_media.up.sql"))
	if !strings.Contains(media, "public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE") {
		t.Fatal("0010 没给 payment_channels 补上 public_id")
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
