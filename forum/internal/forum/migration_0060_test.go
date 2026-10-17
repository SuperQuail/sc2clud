package forum

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"forum/internal/authz"
	"forum/internal/testsupport"
)

// 0060 的 down 必须在**已经有 trigger='edit' 判定行**的库上也能跑通：还原三值约束的唯一办法
// 是先把那些行删掉（见 down 的注释）—— 少了那句 DELETE，ADD CONSTRAINT 会撞既有行（23514），
// 回滚卡在半路。这条用例把三个事实一次钉住：
//   - up 之后 edit 写得进 review_events（本轮修的那条链路的终点）；
//   - down 之后值域回到三值，且那些行被清掉；
//   - 再 up 一次照样能跑（down/up 是一对，不留半截状态）。
func TestMigration0060ReviewTriggerEdit(t *testing.T) {
	h := newHarness(t) // 每个用例一个 schema + 真迁移（0060 的 up 已经跑过）
	author, _ := h.author("alice", 1, false, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)
	id := h.topicID(t, h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "帖子", ContentMD: "正文"}).ID)

	run := func(name string) {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(testsupport.MigrationsDir(), name))
		if err != nil {
			t.Fatalf("读不到 %s：%v", name, err)
		}
		if _, err := h.pool.Exec(h.ctx, string(raw)); err != nil {
			t.Fatalf("跑 %s 失败: %v", name, err)
		}
	}
	insertEdit := func() error {
		_, err := h.pool.Exec(h.ctx,
			"INSERT INTO review_events (topic_id, trigger, source, verdict) VALUES ($1, 'edit', 'ai', 'approve')", id)
		return err
	}

	if err := insertEdit(); err != nil {
		t.Fatalf("0060 之后 trigger='edit' 该能写进 review_events: %v", err)
	}

	run("0060_review_events_trigger_edit.down.sql")
	if n := h.countRows(t, "SELECT count(*) FROM review_events WHERE trigger = 'edit'"); n != 0 {
		t.Fatalf("down 必须把 trigger='edit' 的行删掉（否则 ADD CONSTRAINT 会撞它们），实际还剩 %d 行", n)
	}
	if err := insertEdit(); err == nil {
		t.Fatal("down 之后三值约束该回来了：trigger='edit' 必须写不进去")
	} else if !strings.Contains(err.Error(), "ck_review_events_trigger") {
		t.Fatalf("拒绝的理由该是那条 CHECK，实际 %v", err)
	}

	run("0060_review_events_trigger_edit.up.sql")
	if err := insertEdit(); err != nil {
		t.Fatalf("再 up 之后该又能写: %v", err)
	}
}
