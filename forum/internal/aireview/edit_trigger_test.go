package aireview_test

import (
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/jackc/pgx/v5/stdlib"

	ent "forum/internal/ent"
	"forum/internal/forum/pgsql"
	"forum/internal/platform/ai"
)

// 编辑触发的 AI 审核（trigger='edit'，2026-10-16 接上的那条链路）：
//
//	待审版本   topic_revisions.pending_md —— 作者改完还没过审的那一份（UpdateTopic 存进去的）
//	线上版本   posts（floor=1）—— 读者看到的唯一来源，只在**放行**那一刻换
//
// 三条规矩：判的是**待审那一份**（与审核队列预览同源）；approve 要**放行改动**
// （与人工放行的后置条件逐条相同）；reject / review 只留痕，**绝不动主题状态与可见性** ——
// 一篇已经发布过的帖子不能因为 AI 对改动的意见而被读者 404（「宁可放过，不可错杀」）。

// pending 造一份待审改动：content_* 抄 posts 当前那一份（= 线上版本），pending_* 放这次改动 ——
// 与 UpdateTopic 的 SavePendingRevision 写出来的行逐字同形。
func (h *harness) pending(topicID int64, md, html string) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO topic_revisions (topic_id, post_id, content_md, content_html, pending_md, pending_html, pending_at) "+
			"SELECT p.topic_id, p.id, p.content_md, p.content_html, $2, $3, now() "+
			"FROM posts p WHERE p.topic_id = $1 AND p.floor = 1", topicID, md, html); err != nil {
		h.t.Fatalf("造待审槽: %v", err)
	}
}

// strOf 是 *string → string（nil 当空串）：判「没动过」要按值比。
func strOf(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (h *harness) exec(sql string, args ...any) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx, sql, args...); err != nil {
		h.t.Fatalf("执行 %q: %v", sql, err)
	}
}

// shape 是 promote 的全部后置条件：正文三处 + 摘要 + 待审三列是否清空。
// 它同时是「aireview 的 promote 与 pgsql.PromotePendingRevision 同形」那条用例的比较对象。
type shape struct {
	PostMD, PostHTML, Excerpt string
	RevMD, RevHTML            string
	PendingCleared            bool
}

func (h *harness) shape(topicID int64) shape {
	h.t.Helper()
	var s shape
	if err := h.pool.QueryRow(h.ctx,
		"SELECT p.content_md, p.content_html, t.excerpt, r.content_md, r.content_html, "+
			"(r.pending_md IS NULL AND r.pending_html IS NULL AND r.pending_at IS NULL) "+
			"FROM topics t "+
			"JOIN posts p ON p.topic_id = t.id AND p.floor = 1 "+
			"JOIN topic_revisions r ON r.topic_id = t.id "+
			"WHERE t.id = $1", topicID).Scan(
		&s.PostMD, &s.PostHTML, &s.Excerpt, &s.RevMD, &s.RevHTML, &s.PendingCleared); err != nil {
		h.t.Fatalf("读行形状: %v", err)
	}
	return s
}

func (h *harness) event(id int64) (trigger, source, verdict, reason string) {
	h.t.Helper()
	if err := h.pool.QueryRow(h.ctx,
		"SELECT trigger, source, verdict, reason FROM review_events WHERE topic_id = $1 ORDER BY id DESC LIMIT 1", id).
		Scan(&trigger, &source, &verdict, &reason); err != nil {
		h.t.Fatalf("读 review_events: %v", err)
	}
	return
}

// ① 判定输入必须是**待审的那一份**：真判定与审核队列预览读同一条（pgsql/review_queue.go 的
// COALESCE(rv.pending_md, p.content_md)）。拿线上旧文去判 = 审错对象，还可能把旧文写成 approved。
func TestEditReviewJudgesThePendingDraft(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("教程", "线上旧正文", nil, "approved")
	h.pending(id, "待审的新正文", "<p>待审的新正文</p>")
	h.judge.next = ai.Result{Verdict: ai.Reject, Reason: "以后再说", Model: "fake-model"}

	if err := h.svc.ReviewTopic(h.ctx, id, "edit"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	if !strings.Contains(h.judge.text, "待审的新正文") {
		t.Fatalf("判定输入该是待审槽那一份，实际 %q", h.judge.text)
	}
	if strings.Contains(h.judge.text, "线上旧正文") {
		t.Fatalf("判定输入里出现了线上旧正文（sqlSubject 又读回 posts 了）：%q", h.judge.text)
	}
	// ④ 触发器 edit 能写进 review_events（不撞 0020 的 ck_review_events_trigger = 23514）。
	if trigger, source, verdict, _ := h.event(id); trigger != "edit" || source != "ai" || verdict != "reject" {
		t.Fatalf("留痕形状不对: trigger=%q source=%q verdict=%q", trigger, source, verdict)
	}
}

// ② approve = 放行改动：后置条件与人工放行（pgsql.PromotePendingRevision）逐条相同 ——
// posts 正文、摘要、快照 content_*、待审三列全空。少了替换这一步，作者的改动永远上不了台。
func TestEditApprovePromotesTheDraft(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("教程", "线上旧正文", nil, "approved")
	h.exec("UPDATE topics SET excerpt = '旧摘要', review_note = '上一版 AI 的话' WHERE id = $1", id)
	h.pending(id, "V2 改动", "<p>V2 改动</p>")

	if err := h.svc.ReviewTopic(h.ctx, id, "edit"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}

	got := h.shape(id)
	if got.PostMD != "V2 改动" || got.PostHTML != "<p>V2 改动</p>" {
		t.Fatalf("approve 该把待审改动换成线上正文，实际 %q / %q", got.PostMD, got.PostHTML)
	}
	if got.Excerpt != "V2 改动" {
		t.Fatalf("摘要与正文同源（人工放行也换它），实际 %q", got.Excerpt)
	}
	if got.RevMD != "V2 改动" || got.RevHTML != "<p>V2 改动</p>" {
		t.Fatalf("快照要与线上正文逐字相同，实际 %q / %q", got.RevMD, got.RevHTML)
	}
	if !got.PendingCleared {
		t.Fatal("放行之后待审三列必须全空（留着会让下一次编辑读出上一份草稿）")
	}

	state, _, source, note := h.topicState(id)
	if state != "approved" || source == nil || *source != "ai" {
		t.Fatalf("判定要落库：state=%q source=%v", state, source)
	}
	if note == nil || !strings.Contains(*note, "AI 审核") {
		t.Fatalf("review_note 该是这次 AI 的理由，实际 %v", note)
	}
	var reviewedAt *time.Time
	if err := h.pool.QueryRow(h.ctx, "SELECT reviewed_at FROM topics WHERE id = $1", id).Scan(&reviewedAt); err != nil {
		t.Fatal(err)
	}
	if reviewedAt == nil {
		t.Fatal("reviewed_at 必须写下这次判定的时刻")
	}
	if trigger, src, verdict, _ := h.event(id); trigger != "edit" || src != "ai" || verdict != "approve" {
		t.Fatalf("留痕形状不对: trigger=%q source=%q verdict=%q", trigger, src, verdict)
	}
}

// ③ reject / review 只留痕：**绝不动** topics.review_state / visibility / review_note，
// 也不清待审槽 —— 一篇已经发布过的帖子不能因为 AI 对改动的意见而被读者 404；
// 人工队列要继续能看到这份草稿去判。
func TestEditRejectOrReviewOnlyLeavesAnEvent(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("教程", "线上旧正文", nil, "approved")
	h.exec("UPDATE topics SET excerpt = '旧摘要', review_note = '上一版 AI 的话' WHERE id = $1", id)
	h.pending(id, "V2 改动", "<p>V2 改动</p>")
	beforeState, beforeVis, beforeSource, beforeNote := h.topicState(id)

	for _, tc := range []struct {
		name    string
		verdict ai.Verdict
	}{
		{"判违规", ai.Reject},
		{"拿不准", ai.Review},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h.judge.next = ai.Result{Verdict: tc.verdict, Reason: "改动里有广告", Categories: []string{"ad"}, Model: "fake-model"}
			if err := h.svc.ReviewTopic(h.ctx, id, "edit"); err != nil {
				t.Fatalf("ReviewTopic: %v", err)
			}

			state, vis, source, note := h.topicState(id)
			if state != beforeState || vis != beforeVis {
				t.Fatalf("AI 对改动的意见不许动主题状态/可见性（读者会 404）：state=%q→%q vis=%q→%q",
					beforeState, state, beforeVis, vis)
			}
			if strOf(source) != strOf(beforeSource) || strOf(note) != strOf(beforeNote) {
				t.Fatalf("审查来源与批注都不该动：source=%v→%v note=%v→%v",
					beforeSource, source, beforeNote, note)
			}
			// 线上还是旧正文，草稿留在待审槽里（人工接着判）。
			got := h.shape(id)
			if got.PostMD != "线上旧正文" || got.PendingCleared {
				t.Fatalf("线上正文与待审槽都不该动，实际 %+v", got)
			}
			if trigger, src, verdict, _ := h.event(id); trigger != "edit" || src != "ai" || verdict != string(tc.verdict) {
				t.Fatalf("留痕形状不对: trigger=%q source=%q verdict=%q", trigger, src, verdict)
			}
		})
	}
}

// ⑥ 从没过审的帖（没有待审槽）：编辑走的是 n==0 那一支 —— 正文直接写 posts 并打回 pending
// （那是作者自己的新帖，别人看不到它）。这时 AI 判通过**没有「改动要替换」**，只有状态那一半：
// 少了它，作者改完自己的待审帖、AI 也说通过，帖子却永远上不了线。
func TestEditApproveWithoutDraftJustApproves(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("新帖", "作者自己的新正文", nil, "pending")

	if err := h.svc.ReviewTopic(h.ctx, id, "edit"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	state, _, source, _ := h.topicState(id)
	if state != "approved" || source == nil || *source != "ai" {
		t.Fatalf("没有待审槽时 approve 只该落状态：state=%q source=%v", state, source)
	}
	var n int
	if err := h.pool.QueryRow(h.ctx, "SELECT count(*) FROM topic_revisions WHERE topic_id = $1", id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("没有待审改动就不该凭空造一份快照行（首次批准不写快照），实际 %d 行", n)
	}
	if trigger, src, verdict, _ := h.event(id); trigger != "edit" || src != "ai" || verdict != "approve" {
		t.Fatalf("留痕形状不对: trigger=%q source=%q verdict=%q", trigger, src, verdict)
	}
}

// ⑤ 「同一动作的两个实现」必须同形：aireview 的 promote（pgx.Tx）与 forum/pgsql 的
// PromotePendingRevision（database/sql 口味的 Querier）对同一份待审内容写出来的行，逐列相同。
// 跨包 + 跨 Tx 类型，共用不了语句 —— 任一边单独改了 SQL 而另一边没改，这条就红。
func TestEditPromoteMatchesManualPromote(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	aiTopic := h.topic("AI 放行", "线上旧正文", nil, "approved")
	manualTopic := h.topic("人工放行", "线上旧正文", nil, "approved")
	h.pending(aiTopic, "V2 改动", "<p>V2 改动</p>")
	h.pending(manualTopic, "V2 改动", "<p>V2 改动</p>")

	if err := h.svc.ReviewTopic(h.ctx, aiTopic, "edit"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}

	db := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(h.pool))))
	defer func() { _ = db.Close() }()
	tx, err := db.Tx(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	// 人工那条路的 md/html/excerpt 由 service 现给（review_queue.go 的 render + clipExcerpt）：
	// 这里给的就是**同一份** —— 同一个 md、同一份 html、从它提出来的纯文本。
	if err := pgsql.NewStore(db).PromotePendingRevision(h.ctx, tx, manualTopic, h.authorID,
		"V2 改动", "<p>V2 改动</p>", "V2 改动", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	if a, m := h.shape(aiTopic), h.shape(manualTopic); a != m {
		t.Fatalf("两套 promote 的后置条件不同形：\nAI   = %+v\n人工 = %+v", a, m)
	}
}
