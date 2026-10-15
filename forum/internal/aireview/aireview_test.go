package aireview_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/aireview"
	ent "forum/internal/ent"
	"forum/internal/platform/ai"
	"forum/internal/platform/clock"
	pgmail "forum/internal/platform/mail"
	"forum/internal/platform/queue"
	"forum/internal/report"
	"forum/internal/testsupport"
)

// 用例跑在真 PostgreSQL 上（testsupport 每个用例一个 schema）：本域的全部行为都在 SQL 里
// （sql.go），假库证明不了「八步」有没有走通。外呼是唯一注入点（fakeJudge）。
func TestMain(m *testing.M) { testsupport.Main(m) }

// testKey 是 32 字节 hex：与发信同一套 Crypter（d7 §2.1），用例里就用真实现，不用假 Crypter。
const testKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

// settings 是 site.Service 的最小替身：本域只读这两个键（d7 §2.2）。
type settings struct {
	enabled bool
	limit   int
}

func (s *settings) SettingBool(context.Context, string) bool { return s.enabled }
func (s *settings) SettingInt(context.Context, string) int   { return s.limit }

// fakeQueue 接住事务内入队（用例④）；不碰 jobs 表。
type fakeQueue struct{ tasks []queue.Task }

func (q *fakeQueue) EnqueueTx(_ context.Context, _ *ent.Tx, t queue.Task) error {
	q.tasks = append(q.tasks, t)
	return nil
}

// fakeJudge 是注入的假外呼：数次数、回预设判定，并记下收到的 prompt / 正文。
type fakeJudge struct {
	calls  int
	next   ai.Result
	prompt string
	text   string
}

func (f *fakeJudge) call(_ context.Context, _ ai.Config, prompt, text string) (ai.Result, error) {
	f.calls++
	f.prompt, f.text = prompt, text
	return f.next, nil
}

type harness struct {
	t            *testing.T
	ctx          context.Context
	pool         *pgxpool.Pool
	crypter      *pgmail.Crypter
	judge        *fakeJudge
	queue        *fakeQueue
	set          *settings
	svc          *aireview.Service
	authorID     int64
	authorHandle string
	boardID      int64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	applyMigrations(t, ctx, pool)
	crypt, err := pgmail.NewCrypter(testKey)
	if err != nil {
		t.Fatalf("建 Crypter: %v", err)
	}
	h := &harness{
		t: t, ctx: ctx, pool: pool, crypter: crypt,
		judge: &fakeJudge{next: ai.Result{Verdict: ai.Approve, Reason: "没问题", Model: "fake-model", LatencyMS: 7}},
		queue: &fakeQueue{},
		set:   &settings{enabled: true, limit: 3},
	}
	h.svc = aireview.New(pool, h.judge.call, crypt, h.queue, h.set,
		&clock.Fake{T: time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)}, testLogger())
	h.authorHandle = "author" + uuid.NewString()[:6]
	h.authorID = h.user(h.authorHandle)
	if err := h.pool.QueryRow(ctx, `INSERT INTO boards (slug, name) VALUES ($1, '测试分区') RETURNING id`,
		"b"+uuid.NewString()[:8]).Scan(&h.boardID); err != nil {
		t.Fatalf("建分区: %v", err)
	}
	return h
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

func applyMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	dir := testsupport.MigrationsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".up.sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(raw)); err != nil {
			t.Fatalf("迁移 %s: %v", name, err)
		}
	}
}

func (h *harness) user(handle string) int64 {
	h.t.Helper()
	var roleID int64
	if err := h.pool.QueryRow(h.ctx, `SELECT id FROM roles ORDER BY id LIMIT 1`).Scan(&roleID); err != nil {
		h.t.Fatalf("读角色: %v", err)
	}
	var id int64
	if err := h.pool.QueryRow(h.ctx, `INSERT INTO users (public_id, username, email, password_hash, nickname, role_id)
		 VALUES ($1::uuid, $2::varchar, $3::varchar, 'x', $4::varchar, $5::bigint) RETURNING id`,
		uuid.New(), handle, handle+"@example.com", handle, roleID).Scan(&id); err != nil {
		h.t.Fatalf("建用户: %v", err)
	}
	return id
}

// topic 建一篇真主题 + 1 楼正文（sqlSubject 读的就是这两张表），返回内部 id。
func (h *harness) topic(title, body string, reviewSource *string, state string) int64 {
	h.t.Helper()
	var id int64
	if err := h.pool.QueryRow(h.ctx, `INSERT INTO topics (public_id, board_id, author_id, title, review_state, review_source)
		 VALUES ($1::uuid, $2, $3, $4, $5, $6) RETURNING id`,
		uuid.New(), h.boardID, h.authorID, title, state, reviewSource).Scan(&id); err != nil {
		h.t.Fatalf("建主题: %v", err)
	}
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO posts (public_id, topic_id, author_id, floor, content_md, content_html)
		 VALUES ($1::uuid, $2, $3, 1, $4, $5)`, uuid.New(), id, h.authorID, body, "<p>"+body+"</p>"); err != nil {
		h.t.Fatalf("建 1 楼: %v", err)
	}
	return id
}

// putKey 配好密钥（写进去的是密文，与发信账号同一套）。
func (h *harness) putKey() {
	h.t.Helper()
	cipher, nonce, err := h.crypter.Encrypt([]byte("sk-test"), []byte("ai_config:1"))
	if err != nil {
		h.t.Fatalf("加密密钥: %v", err)
	}
	if _, err := h.pool.Exec(h.ctx, `UPDATE ai_config SET secret_cipher = $1, secret_nonce = $2 WHERE id = 1`, cipher, nonce); err != nil {
		h.t.Fatalf("写密钥: %v", err)
	}
}

func (h *harness) topicState(id int64) (state, visibility string, source, note *string) {
	h.t.Helper()
	if err := h.pool.QueryRow(h.ctx,
		`SELECT review_state, visibility, review_source, review_note FROM topics WHERE id = $1`, id).
		Scan(&state, &visibility, &source, &note); err != nil {
		h.t.Fatalf("读主题: %v", err)
	}
	return state, visibility, source, note
}

func (h *harness) eventCount(id int64) int {
	h.t.Helper()
	var n int
	if err := h.pool.QueryRow(h.ctx, `SELECT count(*) FROM review_events WHERE topic_id = $1`, id).Scan(&n); err != nil {
		h.t.Fatalf("数 review_events: %v", err)
	}
	return n
}

// ① d7 §10 验收 1：没配密钥 / 总开关关掉 —— **一个外呼都不发**，主题留 pending。
func TestNoOutboundWhenOffOrWithoutKey(t *testing.T) {
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
			id := h.topic("一篇正常帖子", "正文内容", nil, "pending")

			if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
				t.Fatalf("ReviewTopic: %v", err)
			}
			if h.judge.calls != 0 {
				t.Fatalf("不该外呼，实际 %d 次", h.judge.calls)
			}
			if n := h.eventCount(id); n != 0 {
				t.Fatalf("不该留判定，实际 %d 条", n)
			}
			if state, _, _, _ := h.topicState(id); state != "pending" {
				t.Fatalf("该留在 pending 交人工，实际 %q", state)
			}
		})
	}
}

// ② 铁律（d7 §1）：**AI 绝不覆盖人工判定** —— review_source='manual' 时任务直接返回。
func TestManualDecisionIsNeverOverwritten(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	manual := "manual"
	id := h.topic("人工审过的帖子", "正文内容", &manual, "rejected")
	if _, err := h.pool.Exec(h.ctx, `UPDATE topics SET review_note = '人工：广告', reviewed_at = now() WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}

	h.judge.next = ai.Result{Verdict: ai.Approve, Reason: "看着没问题"}
	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}

	if h.judge.calls != 0 {
		t.Fatalf("人工已判，不该外呼，实际 %d 次", h.judge.calls)
	}
	state, visibility, source, note := h.topicState(id)
	if state != "rejected" || visibility != "normal" {
		t.Fatalf("人工判定被改了: state=%q visibility=%q", state, visibility)
	}
	if source == nil || *source != "manual" {
		t.Fatalf("review_source 被改了: %v", source)
	}
	if note == nil || *note != "人工：广告" {
		t.Fatalf("review_note 被改了: %v", note)
	}
	if n := h.eventCount(id); n != 0 {
		t.Fatalf("不该留判定，实际 %d 条", n)
	}
}

// ③ 判 reject：review_state=rejected + review_source='ai' + review_events 留一行；
// 正文**不截断**、发出去的内容里**不放作者信息**（d7 §2.4 / §11）。
func TestRejectWritesStateAndEvent(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	body := strings.Repeat("这是很长的正文。", 800) // 6400 字：整篇发出去，一个字都不许截
	id := h.topic("看看这个项目", body, nil, "pending")
	h.judge.next = ai.Result{Verdict: ai.Reject, Reason: "广告引流", Categories: []string{"ad"}, Model: "fake-model", LatencyMS: 12}

	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	if h.judge.calls != 1 {
		t.Fatalf("该外呼一次，实际 %d 次", h.judge.calls)
	}

	state, visibility, source, note := h.topicState(id)
	if state != "rejected" {
		t.Fatalf("review_state=%q，要 rejected", state)
	}
	if source == nil || *source != "ai" {
		t.Fatalf("review_source=%v，要 ai", source)
	}
	if note == nil || !strings.Contains(*note, "广告引流") {
		t.Fatalf("review_note=%v，要含 AI 给的理由", note)
	}
	if visibility != "normal" {
		t.Fatalf("首发审核不该动可见性（只有复审 reject 才 hidden），实际 %q", visibility)
	}

	var (
		trigger, src, verdict, reason, model string
		latency                              int
		categories                           []string
	)
	if err := h.pool.QueryRow(h.ctx,
		`SELECT trigger, source, verdict, reason, model, latency_ms, categories FROM review_events WHERE topic_id = $1`, id).
		Scan(&trigger, &src, &verdict, &reason, &model, &latency, &categories); err != nil {
		t.Fatalf("读 review_events: %v", err)
	}
	if trigger != "create" || src != "ai" || verdict != "reject" {
		t.Fatalf("留痕形状不对: trigger=%q source=%q verdict=%q", trigger, src, verdict)
	}
	if reason != "广告引流" || model != "fake-model" || latency != 12 {
		t.Fatalf("留痕内容不对: reason=%q model=%q latency=%d", reason, model, latency)
	}
	if len(categories) != 1 || categories[0] != "ad" {
		t.Fatalf("categories=%v", categories)
	}

	if !strings.Contains(h.judge.text, body) {
		t.Fatalf("正文被截断了：收到 %d 字，原文 %d 字", len([]rune(h.judge.text)), len([]rune(body)))
	}
	if h.judge.prompt == "" {
		t.Fatal("prompt 不能为空：ai_config.prompt 留空要用内置默认提示词（d7 §4）")
	}
	if strings.Contains(h.judge.text, h.authorHandle) || strings.Contains(h.judge.prompt, h.authorHandle) {
		t.Fatal("发出去的内容里出现了作者信息（d7 §11：昵称/邮箱/IP 与审核无关）")
	}
}

// ⑤ D25 实测：**图片不发**。上行 payload 只有两段纯文本（system=prompt / user=text），
// 正文里的图片只会作为 Markdown 字面量（![...](/img/<hash>)）待在 user 文本里 —— 模型看不到图。
// 这条用例把**实际发出去的请求体形状**钉死：多一个字段、少一个字段都会红。
// 依据：sqlSubject 只取 topics.title + posts(floor=1).content_md，**不 JOIN topic_images**；
// platform/ai.Judge 只组 system + user 两条消息，没有任何图片/多模态字段。
func TestOutboundPayloadHasNoImageField(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	body := "看图：\n\n![封面](/img/0123456789abcdef)\n\n正文若干。"
	id := h.topic("带图的帖子", body, nil, "pending")

	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}

	// 上行只有两条消息：system（prompt）与 user（text），**没有** image_url / content 数组。
	sent := map[string]string{"system": h.judge.prompt, "user": h.judge.text}
	for name, v := range sent {
		if strings.Contains(v, "image_url") || strings.Contains(v, "data:image") {
			t.Fatalf("%s 里出现了图片字段：模型会被塞进图，但本域不该发图", name)
		}
	}
	// user 文本 = 标题 + 正文原文，图片只是 Markdown 字面量（可以证明「图没被当成图发出去」）。
	want := "标题：带图的帖子\n\n正文：\n" + body
	if h.judge.text != want {
		t.Fatalf("上行 user 文本与预期不符：\n得到 %q\n想要 %q", h.judge.text, want)
	}
	// 图片引用原样留在文本里 —— 这是**唯一**让模型知道「这里有张图」的途径。
	if !strings.Contains(h.judge.text, "![封面](/img/0123456789abcdef)") {
		t.Fatal("正文里的图片 Markdown 没进 payload：连「有图」这件事都传不出去")
	}
}

// ④ d7 §6/§7：到第一阈值入队一条 ai:review(trigger=report)；到第二阈值只转人工、**不再入队**。
func TestTriggerReportReview(t *testing.T) {
	h := newHarness(t)
	db := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(h.pool))))
	defer func() { _ = db.Close() }()
	id := h.topic("被举报的帖子", "正文内容", nil, "pending")

	tx, err := db.Tx(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.TriggerReportReview(h.ctx, tx, report.ReportReviewInput{TopicID: id, OpenReports: 3}); err != nil {
		t.Fatalf("TriggerReportReview: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	if len(h.queue.tasks) != 1 {
		t.Fatalf("第一阈值该入队一条，实际 %d", len(h.queue.tasks))
	}
	task := h.queue.tasks[0]
	if task.Type != queue.TypeAIReview || task.Priority != 20 || task.MaxRetry != 2 {
		t.Fatalf("任务形状不对: %+v", task)
	}
	if want := "review:report:" + strconv.FormatInt(id, 10) + ":0"; task.UniqueKey != want {
		t.Fatalf("unique_key=%q，要 %q（同一轮只触发一次）", task.UniqueKey, want)
	}
	var payload map[string]any
	if err := json.Unmarshal(task.Payload.(json.RawMessage), &payload); err != nil {
		t.Fatalf("payload 不是 JSON: %v", err)
	}
	if payload["topic_id"] != float64(id) || payload["trigger"] != "report" {
		t.Fatalf("payload=%v", payload)
	}

	tx2, err := db.Tx(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.TriggerReportReview(h.ctx, tx2, report.ReportReviewInput{TopicID: id, OpenReports: 5, Human: true}); err != nil {
		t.Fatalf("TriggerReportReview(第二阈值): %v", err)
	}
	if err := tx2.Commit(); err != nil {
		t.Fatal(err)
	}
	if len(h.queue.tasks) != 1 {
		t.Fatalf("第二阈值不该再调 AI（防举报风暴打爆额度），实际入队 %d 条", len(h.queue.tasks))
	}
	if _, _, source, _ := h.topicState(id); source == nil || *source != "manual" {
		t.Fatalf("第二阈值该落 review_source=manual，实际 %v", source)
	}
}
