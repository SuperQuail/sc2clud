package forum

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"forum/internal/authz"
	"forum/internal/testsupport"
)

// 0062 的 up / down 必须在**已经有数据**的库上也能跑通，而且 down 之后要能再 up 一次。
//
// 三个事实一次钉住：
//   - up 之后：target_type='issue' 写得进 reports；post_issues 有归档三列；
//     review_events 能写 issue_id 非空、topic_id 为空的行，且「两个都非空」撞 CHECK；
//   - down 之后：值域回到 topic|post|user（issue 举报行被删掉，否则 ADD CONSTRAINT 会撞 23514）；
//     review_events.issue_id 没了、topic_id 回到 NOT NULL；归档三列没了；
//   - 再 up 一次照样能跑（down/up 是一对，不留半截状态）。
func TestMigration0062IssueArchive(t *testing.T) {
	h := newHarness(t) // 每个用例一个 schema + 真迁移（0062 的 up 已经跑过）
	author, _ := h.author("alice", 1, false, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)
	topicID := h.topicID(t, h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "帖子", ContentMD: "正文"}).ID)

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

	// 一条真 Issue（归档与判定事件都要挂在它上面）
	var issueID int64
	if err := h.pool.QueryRow(h.ctx, `INSERT INTO post_issues
		 (public_id, topic_id, author_id, number, kind, title, body_md, body_html, body_text)
		 VALUES (gen_random_uuid(), $1, $2, 1, 'bug', '标题', '正文', '<p>正文</p>', '正文') RETURNING id`,
		topicID, author.UserID).Scan(&issueID); err != nil {
		t.Fatalf("建 Issue: %v", err)
	}

	insertReport := func(targetType string) error {
		_, err := h.pool.Exec(h.ctx, `INSERT INTO reports (public_id, target_type, target_id, reason, reporter_id)
			 VALUES (gen_random_uuid(), $1, $2, 'spam', $3)`, targetType, issueID, author.UserID)
		return err
	}
	insertIssueEvent := func(topicID *int64, issueID *int64) error {
		_, err := h.pool.Exec(h.ctx,
			"INSERT INTO review_events (topic_id, issue_id, trigger, source, verdict) VALUES ($1, $2, 'report', 'ai', 'reject')",
			topicID, issueID)
		return err
	}

	// ① up 之后：issue 举报写得进；issue 判定事件写得进（topic_id 为空）
	if err := insertReport("issue"); err != nil {
		t.Fatalf("0062 之后 target_type='issue' 该能写: %v", err)
	}
	if err := insertIssueEvent(nil, &issueID); err != nil {
		t.Fatalf("0062 之后 issue_id 非空、topic_id 为空的行该能写: %v", err)
	}
	// 「恰好一个非空」：两个都填必须被挡
	if err := insertIssueEvent(&topicID, &issueID); err == nil {
		t.Fatal("topic_id 与 issue_id 都非空该被 ck_review_events_subject 挡住")
	} else if !strings.Contains(err.Error(), "ck_review_events_subject") {
		t.Fatalf("拒绝的理由该是那条 CHECK，实际 %v", err)
	}

	// ② down：还原三值约束（issue 举报行先被删掉）、拆归档三列与 issue_id
	run("0062_issue_archive.down.sql")
	if n := h.countRows(t, "SELECT count(*) FROM reports WHERE target_type = 'issue'"); n != 0 {
		t.Fatalf("down 必须把 target_type='issue' 的行删掉（否则 ADD CONSTRAINT 会撞它们），实际还剩 %d 行", n)
	}
	if err := insertReport("issue"); err == nil {
		t.Fatal("down 之后三值约束该回来了：target_type='issue' 必须写不进去")
	} else if !strings.Contains(err.Error(), "ck_reports_target_type") {
		t.Fatalf("拒绝的理由该是那条 CHECK，实际 %v", err)
	}
	if err := insertIssueEvent(nil, &issueID); err == nil {
		t.Fatal("down 之后 review_events.issue_id 该已经没了")
	}
	// topic_id 回到 NOT NULL：topic_id 为空的行必须写不进去
	if err := insertIssueEvent(nil, nil); err == nil {
		t.Fatal("down 之后 review_events.topic_id 该回到 NOT NULL")
	}
	if n := h.countRows(t,
		"SELECT count(*) FROM information_schema.columns WHERE table_name = 'post_issues' AND column_name IN ('archived_at','archived_by','archive_reason')"); n != 0 {
		t.Fatalf("down 之后归档三列该没了，实际还剩 %d 列", n)
	}

	// ③ 再 up 一次：整对迁移可以来回跑
	run("0062_issue_archive.up.sql")
	if err := insertReport("issue"); err != nil {
		t.Fatalf("再 up 之后 target_type='issue' 该又能写: %v", err)
	}
	if err := insertIssueEvent(nil, &issueID); err != nil {
		t.Fatalf("再 up 之后 issue 判定事件该又能写: %v", err)
	}
}
