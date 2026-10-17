package aireview_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/stdlib"

	ent "forum/internal/ent"
	"forum/internal/platform/ai"
	"forum/internal/platform/queue"
	"forum/internal/report"
)

// 0062_issue_archive：Issue 被举报到阈值之后由 AI 判一次。
//
// 三条落点（与 ReviewTopic 的关系是「开关 / 限额 / 外呼 / 留痕四步同源，只有状态机不同」）：
//
//	approve → 只留事件（不归档：这条反馈不违规）
//	reject  → 归档（archived_at 非空、archived_by=NULL 表示 AI 按的）+ 审计
//	review  → 只留事件（拿不准 → 人工队列，那里本来就有这条举报）
//
// 判定事件写 review_events：issue_id 有值，**topic_id 为 NULL**（0062 的 ck_review_events_subject
// 要求恰好一个非空），trigger='report'、source='ai'。

// issue 建一条真 Issue（post_issues 的必填列都在这里），返回内部 id。
func (h *harness) issue(topicID int64, kind, title, body string) int64 {
	h.t.Helper()
	var id int64
	if err := h.pool.QueryRow(h.ctx, `INSERT INTO post_issues
		 (public_id, topic_id, author_id, number, kind, title, body_md, body_html, body_text)
		 VALUES ($1::uuid, $2, $3, 1, $4, $5, $6, $7, $6) RETURNING id`,
		uuid.New(), topicID, h.authorID, kind, title, body, "<p>"+body+"</p>").Scan(&id); err != nil {
		h.t.Fatalf("建 Issue: %v", err)
	}
	return id
}

// issueArchive 读归档三列 + 对外 id。
func (h *harness) issueArchive(id int64) (publicID, reason string, archivedAt *time.Time, archivedBy *int64) {
	h.t.Helper()
	if err := h.pool.QueryRow(h.ctx,
		"SELECT public_id, archive_reason, archived_at, archived_by FROM post_issues WHERE id = $1", id).
		Scan(&publicID, &reason, &archivedAt, &archivedBy); err != nil {
		h.t.Fatalf("读 Issue: %v", err)
	}
	return
}

// countRows 是「数一行」的小工具（forum 域的测试台里有一个同名的，两个包各持各的）。
func (h *harness) countRows(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := h.pool.QueryRow(h.ctx, sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// entClient 造一个 ent 客户端（TriggerReportReview 收 *ent.Tx）。
func (h *harness) entClient(t *testing.T) *ent.Client {
	t.Helper()
	db := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(h.pool))))
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// issueEvents 数这个 Issue 的判定事件。
func (h *harness) issueEvents(id int64) int {
	h.t.Helper()
	var n int
	if err := h.pool.QueryRow(h.ctx, "SELECT count(*) FROM review_events WHERE issue_id = $1", id).Scan(&n); err != nil {
		h.t.Fatalf("数 Issue 判定事件: %v", err)
	}
	return n
}

func TestReviewIssueRejectArchivesAndAudits(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	topicID := h.topic("资源帖", "正文", nil, "approved")
	issueID := h.issue(topicID, "bug", "第三章崩了", "走到第二波就卡关")
	h.judge.next = ai.Result{Verdict: ai.Reject, Reason: "广告引流", Categories: []string{"ad"}, Model: "fake-model", LatencyMS: 9}

	if err := h.svc.ReviewIssue(h.ctx, issueID, "report"); err != nil {
		t.Fatalf("ReviewIssue: %v", err)
	}
	if h.judge.calls != 1 {
		t.Fatalf("该外呼一次，实际 %d 次", h.judge.calls)
	}
	// 取材：标题 + 正文 + 所属主题（给模型上下文）
	if !strings.Contains(h.judge.text, "第三章崩了") || !strings.Contains(h.judge.text, "走到第二波就卡关") {
		t.Fatalf("判定输入该含 Issue 的标题与正文，实际 %q", h.judge.text)
	}
	if !strings.Contains(h.judge.text, "资源帖") {
		t.Fatalf("判定输入该带上所属主题标题（判它是否跑题的必需上下文），实际 %q", h.judge.text)
	}
	// 本期不发图：一个附件都不该有
	if len(h.judge.images) != 0 {
		t.Fatalf("Issue 没有配图通道，不该发图，实际 %d 张", len(h.judge.images))
	}

	publicID, reason, archivedAt, archivedBy := h.issueArchive(issueID)
	if archivedAt == nil {
		t.Fatal("reject 必须归档（archived_at 非空）")
	}
	if archivedBy != nil {
		t.Fatalf("AI 归档的 archived_by 必须是 NULL（AI 没有 user id），实际 %v", *archivedBy)
	}
	if reason != "广告引流" {
		t.Fatalf("archive_reason 该是 AI 给的理由，实际 %q", reason)
	}
	if n := h.issueEvents(issueID); n != 1 {
		t.Fatalf("该留 1 条判定事件，实际 %d", n)
	}
	var (
		dbTopicID *int64
		trigger   string
		source    string
		verdict   string
	)
	if err := h.pool.QueryRow(h.ctx,
		"SELECT topic_id, trigger, source, verdict FROM review_events WHERE issue_id = $1", issueID).
		Scan(&dbTopicID, &trigger, &source, &verdict); err != nil {
		t.Fatal(err)
	}
	if dbTopicID != nil {
		t.Fatalf("0062 的 ck_review_events_subject 要求 topic_id 与 issue_id 恰好一个非空，topic_id 该是 NULL，实际 %v", *dbTopicID)
	}
	if trigger != "report" || source != "ai" || verdict != "reject" {
		t.Fatalf("留痕形状不对: trigger=%q source=%q verdict=%q", trigger, source, verdict)
	}
	// 审计：action=issue.archive、target_id 是对外 id、detail 里标明是 AI 干的
	var action, targetID, detail string
	if err := h.pool.QueryRow(h.ctx,
		"SELECT action, target_id, detail::text FROM audit_logs WHERE action = 'issue.archive'").Scan(&action, &targetID, &detail); err != nil {
		t.Fatalf("该有一条审计: %v", err)
	}
	if targetID != publicID {
		t.Fatalf("审计的 target_id 该是对外 id %q，实际 %q", publicID, targetID)
	}
	if !strings.Contains(detail, "广告引流") || !strings.Contains(detail, "ai") {
		t.Fatalf("审计 detail 该带理由与 source=ai，实际 %s", detail)
	}
	// 归档之后不再重复判（第二次调用直接返回，不外呼）
	if err := h.svc.ReviewIssue(h.ctx, issueID, "report"); err != nil {
		t.Fatalf("二次 ReviewIssue: %v", err)
	}
	if h.judge.calls != 1 {
		t.Fatalf("已归档的 Issue 不该再判，实际外呼 %d 次", h.judge.calls)
	}
}

func TestReviewIssueApproveAndReviewOnlyLeaveAnEvent(t *testing.T) {
	for _, tc := range []struct {
		name    string
		verdict ai.Verdict
	}{
		{"判通过", ai.Approve},
		{"拿不准", ai.Review},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.putKey()
			topicID := h.topic("资源帖", "正文", nil, "approved")
			issueID := h.issue(topicID, "bug", "疑似广告", "加群 xxx")
			h.judge.next = ai.Result{Verdict: tc.verdict, Reason: "看看", Model: "fake-model"}

			if err := h.svc.ReviewIssue(h.ctx, issueID, "report"); err != nil {
				t.Fatalf("ReviewIssue: %v", err)
			}
			if _, _, archivedAt, _ := h.issueArchive(issueID); archivedAt != nil {
				t.Fatalf("%s 不该归档（只有 reject 才归档）", tc.name)
			}
			if n := h.issueEvents(issueID); n != 1 {
				t.Fatalf("该留 1 条判定事件，实际 %d", n)
			}
			if n := h.countRows(t, "SELECT count(*) FROM audit_logs WHERE action = 'issue.archive'"); n != 0 {
				t.Fatalf("没归档就不该有归档审计，实际 %d 条", n)
			}
			// 判定事件仍然要落库（下一轮的轮次计数靠它）
			var verdict string
			if err := h.pool.QueryRow(h.ctx,
				"SELECT verdict FROM review_events WHERE issue_id = $1", issueID).Scan(&verdict); err != nil {
				t.Fatal(err)
			}
			if verdict != string(tc.verdict) {
				t.Fatalf("verdict=%q，要 %q", verdict, tc.verdict)
			}
		})
	}
}

// 开关与密钥沿用 ReviewTopic 那一套：总开关关 / 没配密钥 —— 一个外呼都不发，不归档、不留痕。
func TestReviewIssueRespectsGate(t *testing.T) {
	for _, tc := range []struct {
		name string
		off  func(s *settings)
		key  bool
	}{
		{"总开关关", func(s *settings) { s.enabled = false }, true},
		{"没配密钥", func(s *settings) {}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			tc.off(h.set)
			if tc.key {
				h.putKey()
			}
			topicID := h.topic("资源帖", "正文", nil, "approved")
			issueID := h.issue(topicID, "bug", "标题", "正文")
			h.judge.next = ai.Result{Verdict: ai.Reject, Reason: "违规"}

			if err := h.svc.ReviewIssue(h.ctx, issueID, "report"); err != nil {
				t.Fatalf("ReviewIssue: %v", err)
			}
			if h.judge.calls != 0 {
				t.Fatalf("不该外呼，实际 %d 次", h.judge.calls)
			}
			if _, _, archivedAt, _ := h.issueArchive(issueID); archivedAt != nil {
				t.Fatal("没外呼就不该归档")
			}
			if n := h.issueEvents(issueID); n != 0 {
				t.Fatalf("不该留判定，实际 %d 条", n)
			}
		})
	}
}

// 举报到阈值 → 入队一条 ai:review（payload 带 issue_id）；同一轮的多次举报只入队一条。
func TestTriggerReportReviewForIssue(t *testing.T) {
	h := newHarness(t)
	topicID := h.topic("资源帖", "正文", nil, "approved")
	issueID := h.issue(topicID, "bug", "被举报的反馈", "正文")

	db := h.entClient(t)
	tx, err := db.Tx(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.TriggerReportReview(h.ctx, tx, report.ReportReviewInput{IssueID: issueID, OpenReports: 3}); err != nil {
		t.Fatalf("TriggerReportReview: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if len(h.queue.tasks) != 1 {
		t.Fatalf("第一阈值该入队一条，实际 %d", len(h.queue.tasks))
	}
	task := h.queue.tasks[0]
	if task.Type != queue.TypeAIReview {
		t.Fatalf("任务类型不对: %s", task.Type)
	}
	var payload map[string]any
	if err := json.Unmarshal(task.Payload.(json.RawMessage), &payload); err != nil {
		t.Fatalf("payload 不是 JSON: %v", err)
	}
	if payload["issue_id"] != float64(issueID) || payload["trigger"] != "report" {
		t.Fatalf("payload 该带 issue_id 而不是 topic_id: %v", payload)
	}
	if _, ok := payload["topic_id"]; ok {
		t.Fatalf("Issue 的 payload 不该带 topic_id: %v", payload)
	}
	// 第二阈值：不调 AI，也不入队（Issue 没有 review_source 可落，转人工就是「不入队」）
	tx2, err := db.Tx(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.TriggerReportReview(h.ctx, tx2, report.ReportReviewInput{IssueID: issueID, OpenReports: 5, Human: true}); err != nil {
		t.Fatalf("TriggerReportReview(第二阈值): %v", err)
	}
	if err := tx2.Commit(); err != nil {
		t.Fatal(err)
	}
	if len(h.queue.tasks) != 1 {
		t.Fatalf("第二阈值不该再调 AI，实际入队 %d 条", len(h.queue.tasks))
	}
}
