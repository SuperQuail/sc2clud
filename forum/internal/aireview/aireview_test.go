package aireview_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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
	"forum/internal/platform/apperr"
	"forum/internal/platform/clock"
	pgmail "forum/internal/platform/mail"
	"forum/internal/platform/queue"
	"forum/internal/report"
	"forum/internal/testsupport"
)

// 用例跑在真 PostgreSQL 上（testsupport 每个用例一个 schema）：本域的全部行为都在 SQL 里
// （sql.go），假库证明不了「八步」有没有走通。外呼是唯一注入点（fakeJudge）。
func TestMain(m *testing.M) { testsupport.Main(m) }

// reviewToolCall 是假上游回的一次 submit_review（真外呼那条用例要它）。
const reviewToolCall = `{"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":[{"id":"c1","type":"function","function":{"name":"submit_review","arguments":"{\"verdict\":\"approve\",\"reason\":\"图没问题\"}"}}]}}]}`

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

// fakeJudge 是注入的假外呼：数次数、回预设判定，并记下收到的 prompt / 正文 / **附带的图**与这次的超时。
type fakeJudge struct {
	calls   int
	next    ai.Result
	err     error
	prompt  string
	text    string
	images  []ai.Attachment
	timeout time.Duration
}

func (f *fakeJudge) call(_ context.Context, cfg ai.Config, prompt, text string, images []ai.Attachment) (ai.Result, error) {
	f.calls++
	f.prompt, f.text, f.images, f.timeout = prompt, text, images, cfg.Timeout
	return f.next, f.err
}

// fakeImages 是配图读口的替身：**凡是在 images 表里登记过的 hash 都当成「文件在」**，
// 字节 = 表里登记的 size 那么多个 0xAB。这样任何插入过 images 行的用例都不必再手工喂字节
// （preview_test.go 的 withImage 就是这么用的）；要模拟「行在文件丢」就往 missing 里放一个 hash。
type fakeImages struct {
	pool    *pgxpool.Pool
	missing map[string]bool
	reads   int
}

func (f *fakeImages) ReadImageBytes(ctx context.Context, hash string) ([]byte, string, error) {
	f.reads++
	if f.missing[hash] {
		return nil, "", errors.New("image: not found")
	}
	var (
		size int
		mime string
	)
	if err := f.pool.QueryRow(ctx, "SELECT size, mime FROM images WHERE hash = $1", hash).Scan(&size, &mime); err != nil {
		return nil, "", err
	}
	return bytes.Repeat([]byte{0xAB}, size), mime, nil
}

type harness struct {
	t            *testing.T
	ctx          context.Context
	pool         *pgxpool.Pool
	crypter      *pgmail.Crypter
	judge        *fakeJudge
	reader       *fakeImages
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
	h.reader = &fakeImages{pool: pool, missing: map[string]bool{}}
	h.svc = aireview.New(pool, h.judge.call, h.reader, crypt, h.queue, h.set,
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

// attach 给主题挂一张图（images 行 + topic_images 引用行）——字节由 fakeImages 按登记的 size 合成，
// 所以用例不必手工喂字节。sort 是 post 内的位置（uq_topic_images_sort 保证同楼不撞）。
func (h *harness) attach(topicID int64, hash string, sort int) {
	h.attachSized(topicID, hash, sort, 512)
}

func (h *harness) attachSized(topicID int64, hash string, sort, size int) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO images (hash, size, mime, width, height) VALUES ($1, $2, 'image/webp', 800, 600)",
		hash, size); err != nil {
		h.t.Fatalf("建图片: %v", err)
	}
	var postID int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM posts WHERE topic_id = $1 AND floor = 1", topicID).Scan(&postID); err != nil {
		h.t.Fatalf("读 1 楼: %v", err)
	}
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO topic_images (topic_id, post_id, image_hash, sort) VALUES ($1, $2, $3, $4)",
		topicID, postID, hash, sort); err != nil {
		h.t.Fatalf("挂配图: %v", err)
	}
}

// eventImages 读最近一条 review_events 的「判了几张图 / 截了几张 / 用的哪个模型」。
func (h *harness) eventImages(id int64) (count, skipped int, model string) {
	h.t.Helper()
	if err := h.pool.QueryRow(h.ctx,
		"SELECT image_count, image_skipped, model FROM review_events WHERE topic_id = $1 ORDER BY id DESC LIMIT 1", id).
		Scan(&count, &skipped, &model); err != nil {
		h.t.Fatalf("读 review_events: %v", err)
	}
	return
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

// ⑤ D33③（2026-10-15 用户拍板真做多模态）：**带图帖必须有 image 块**。
//
// 这条推翻了原来 TestOutboundPayloadHasNoImageField 的结论（那时钉的是「不发图」），
// 但钉的是同一件事的两面：**有图 → 必须有**（本条）、**无图 → 必须没有**（下一条）。
// 只留一面都会漏：只钉「有图要发」，无图帖被塞进空图块也没人管；只钉「无图不发」，功能没接上也照样绿。
//
// 依据（现在）：sqlTopicImages 取 topic_images（页面顺序）→ loadImages 按上限读字节 →
// platform/ai.JudgeImages 组 [text, image_url…] 的块数组。三处任一断掉这条都会红。
func TestOutboundPayloadCarriesImageBlocks(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	body := "看图：\n\n![封面](/img/0123456789abcdef)\n\n正文若干。"
	id := h.topic("带图的帖子", body, nil, "pending")
	h.attach(id, hash64("a"), 0)

	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	if len(h.judge.images) != 1 {
		t.Fatalf("带图帖必须附一张图，实际 %d 张", len(h.judge.images))
	}
	if n := len(h.judge.images[0].Data); n != 512 {
		t.Fatalf("附上去的字节数不对：%d（fakeImages 按 images.size 合成）", n)
	}
	if h.judge.images[0].MIME != "image/webp" {
		t.Fatalf("mime 该照 images 行给：%q", h.judge.images[0].MIME)
	}
	// 图是**附带**上去的，不是替换文本：user 文本仍是标题 + 正文原文（含那行 Markdown 字面量）。
	if want := "标题：带图的帖子\n\n正文：\n" + body; h.judge.text != want {
		t.Fatalf("上行 user 文本与预期不符：\n得到 %q\n想要 %q", h.judge.text, want)
	}
	// 审核记录：判了几张图（迁移 0053 的两列）—— 申诉与复盘时唯一能信的数。
	count, skipped, model := h.eventImages(id)
	if count != 1 || skipped != 0 {
		t.Fatalf("review_events 该记「判了 1 张、截了 0 张」，实际 %d / %d", count, skipped)
	}
	if model == "" {
		t.Fatal("review_events.model 是空的：审核记录必须写清用的哪个模型")
	}
}

// 管理端手里只有**对外 id**（uuid）：审核队列 DTO 的 id 就是 topics.public_id，自增 bigint
// 不出现在任何管理端回执里。没有这条换算，「选一条带图帖试跑」（D33④）在界面上根本填不出 topic_id。
//
// 先红：TopicIDByPublicID 不存在时编译不过；把它实现成直接拼进 SQL 时，最后两条断言会红
//（非 uuid → 22P02 → 500；不存在的 id → 0 行 → 空 id）—— 那正是本仓库记过的那类缺陷形态。
func TestTopicIDByPublicIDIsTheAdminSideAddress(t *testing.T) {
	h := newHarness(t)
	id := h.topic("带图的帖子", "正文", nil, "pending")
	var publicID string
	if err := h.pool.QueryRow(h.ctx, "SELECT public_id FROM topics WHERE id = $1", id).Scan(&publicID); err != nil {
		t.Fatal(err)
	}
	got, err := h.svc.TopicIDByPublicID(h.ctx, publicID)
	if err != nil || got != id {
		t.Fatalf("对外 id 换算错：得到 %d / %v，想要 %d", got, err, id)
	}
	// 换算出来的 id 必须能直接喂给预览（换算完就该是同一条路，不是第二条）。
	if _, err := h.svc.Preview(h.ctx, aireview.PayloadInput{TopicID: got}); err != nil {
		t.Fatalf("换算出来的 id 喂不进 Preview: %v", err)
	}
	// 非 uuid **不能**送进 SQL：那是 22P02 → 500 的形状，这里必须是 400。
	_, err = h.svc.TopicIDByPublicID(h.ctx, "not-a-uuid")
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Status != 400 {
		t.Fatalf("非 uuid 该回 400 的业务错误，实际 %v", err)
	}
	// 查不到该是 404（不是 500，也不是 0）。
	if _, err := h.svc.TopicIDByPublicID(h.ctx, uuid.NewString()); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("不存在的主题该回 404，实际 %v", err)
	}
}

// **线上形状的最终证据**：把真外呼（platform/ai.JudgeImages）接上，让假上游把收到的请求体原样抓下来 ——
// 前面那些用例注入的是假外呼，它们证明的是「我们把图交给了外呼口」；这一条证明的是
// 「外呼口真的把它编成了 image_url 的 data URL，且字节就是 media 里那一份」。
// 中间任何一段断掉（取图、上限、编码、组块）这条都会红，而它是唯一能红的形状。
func TestImagesReachTheWireAsDataURL(t *testing.T) {
	h := newHarness(t)
	// 真外呼那一条（judge 传 nil 就是 ai.JudgeImages），base_url 指向假上游。
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(reviewToolCall))
	}))
	defer srv.Close()
	if _, err := h.pool.Exec(h.ctx, "UPDATE ai_config SET base_url = $1 WHERE id = 1", srv.URL); err != nil {
		t.Fatal(err)
	}
	h.putKey()
	svc := aireview.New(h.pool, nil, h.reader, h.crypter, h.queue, h.set,
		&clock.Fake{T: time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)}, testLogger())

	hash := hash64("e")
	id := h.topic("带图的帖子", "看图：\n\n![封面](/img/"+hash+")\n\n完。", nil, "pending")
	h.attachSized(id, hash, 0, 1024)

	if err := svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic(真外呼): %v", err)
	}
	if body == "" {
		t.Fatal("假上游一个请求都没收到")
	}
	// content 是联合类型：system 那条是**字符串**，user 那条才是块数组 —— 用 RawMessage 分开解，
	// 这样「system 也被改成了块数组」这种形状变化同样会让这条红。
	var sent struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &sent); err != nil {
		t.Fatalf("上游收到的不是 JSON: %v", err)
	}
	if len(sent.Messages) != 2 || sent.Messages[0].Role != "system" || sent.Messages[1].Role != "user" {
		t.Fatalf("上游该收到 [system, user]，实际 %s", body)
	}
	var system string
	if err := json.Unmarshal(sent.Messages[0].Content, &system); err != nil {
		t.Fatalf("system 那条该仍是一段纯文本：%s", sent.Messages[0].Content)
	}
	var parts []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL struct {
			URL string `json:"url"`
		} `json:"image_url"`
	}
	if err := json.Unmarshal(sent.Messages[1].Content, &parts); err != nil {
		t.Fatalf("user 那条该是块数组：%s", sent.Messages[1].Content)
	}
	if len(parts) != 2 {
		t.Fatalf("上游该收到 [system, user[text, image]]，实际 %s", body)
	}
	want := "data:image/webp;base64," + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xAB}, 1024))
	if got := parts[1].ImageURL.URL; got != want {
		t.Fatalf("上行图片字节与 media 里那一份不符：\n得到 %.60s…\n想要 %.60s…", got, want)
	}
	// 判定照常落库（这条链路的终点仍然是状态机）。
	if state, _, source, _ := h.topicState(id); state != "approved" || source == nil || *source != "ai" {
		t.Fatalf("判定没落库：state=%q source=%v", state, source)
	}
	if count, _, _ := h.eventImages(id); count != 1 {
		t.Fatalf("review_events 该记 1 张图，实际 %d", count)
	}
}

// 无图帖**一个字节都不上行**：不许因为「反正字段在那儿」就给所有请求加空图块。
// （旧断言的那一半在这里活下来 —— 它本来就是对的。）
func TestOutboundPayloadHasNoImageBlockWithoutImages(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("纯文字帖子", "正文里没有图片标记。", nil, "pending")

	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	if h.judge.calls != 1 {
		t.Fatalf("该外呼一次，实际 %d 次", h.judge.calls)
	}
	if len(h.judge.images) != 0 {
		t.Fatalf("无图帖不许附图，实际 %d 张", len(h.judge.images))
	}
	if h.reader.reads != 0 {
		t.Fatalf("无图帖不该去读盘，实际读了 %d 次", h.reader.reads)
	}
	if count, skipped, _ := h.eventImages(id); count != 0 || skipped != 0 {
		t.Fatalf("无图帖该记 0/0，实际 %d / %d", count, skipped)
	}
	// 文本里也不许冒出 data URL / image_url 这类东西（那是「图被编进正文」的形状）。
	for _, s := range []string{h.judge.prompt, h.judge.text} {
		if strings.Contains(s, "image_url") || strings.Contains(s, "data:image") {
			t.Fatal("无图帖的文本里出现了图片字段")
		}
	}
}

// 上限：超过 maxImages 张 —— **截断并计数**（review_events.image_skipped），不许静默丢一张。
// 顺序照页面顺序：保住的是最前面那几张（正常帖子的图都在 1 楼）。
func TestImageLimitTruncatesAndCounts(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("图很多的帖子", "正文", nil, "pending")
	// 6 张：上限是 4（images.go 的 maxImages）。这里写死数字是**有意的** —— 上限被改动时这条该红，
	// 它钉的就是「4 张」这个决定，不是「某个常量等于它自己」。
	for i := 0; i < 6; i++ {
		h.attach(id, hash64(string(rune('a'+i))), i)
	}

	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	if len(h.judge.images) != 4 {
		t.Fatalf("该发 4 张（截断），实际 %d 张", len(h.judge.images))
	}
	count, skipped, _ := h.eventImages(id)
	if count != 4 || skipped != 2 {
		t.Fatalf("记录该是「判了 4 张、截了 2 张」，实际 %d / %d", count, skipped)
	}
}

// 单张超过上限：**跳过那一张继续判**（这是我们自己的额度上限，不是读不到 —— 不转人工），
// 并且照样计数（截断不许静默）。
func TestOversizeImageIsSkippedNotFatal(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("有一张超大图", "正文", nil, "pending")
	h.attachSized(id, hash64("a"), 0, 64)    // 正常
	h.attachSized(id, hash64("b"), 1, 3<<20) // 3 MiB > 单张上限 2 MiB（images.go 的 maxImageBytes）

	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	if len(h.judge.images) != 1 {
		t.Fatalf("超限那张不该发，实际发了 %d 张", len(h.judge.images))
	}
	if count, skipped, _ := h.eventImages(id); count != 1 || skipped != 1 {
		t.Fatalf("记录该是 1 / 1，实际 %d / %d", count, skipped)
	}
	// 判定照常落库（不是转人工）：state 与 source 都要动。
	if state, _, source, _ := h.topicState(id); state != "approved" || source == nil || *source != "ai" {
		t.Fatalf("超限只该截断那一张，判定仍要落库：state=%q source=%v", state, source)
	}
}

// **读图失败 → 转人工**（D33③ 的硬要求）：文件丢了既不是违规、也不该让整帖判定失败。
// 具体形状：不外呼、不写 review_events、不动 review_state、**不返回错误**（返回错误会让队列重试，
// 而重试也是同样的结果）；只把原因记进 ai_config.last_error 让运维看得见。
func TestUnreadableImageGoesToHuman(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("配图丢了", "正文", nil, "pending")
	missing := hash64("d")
	h.attach(id, missing, 0)
	h.reader.missing[missing] = true

	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("读图失败不该当整帖判定失败（返回错误会让队列反复重试）：%v", err)
	}
	if h.judge.calls != 0 {
		t.Fatalf("图都读不到，不该拿半份内容去外呼，实际 %d 次", h.judge.calls)
	}
	if n := h.eventCount(id); n != 0 {
		t.Fatalf("转人工不是一次判定，不该留 review_events，实际 %d 条", n)
	}
	if state, _, source, _ := h.topicState(id); state != "pending" || source != nil {
		t.Fatalf("该原样留在 pending 交人工：state=%q source=%v", state, source)
	}
	var lastError string
	if err := h.pool.QueryRow(h.ctx, "SELECT last_error FROM ai_config WHERE id = 1").Scan(&lastError); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(lastError, "配图") {
		t.Fatalf("ai_config.last_error 该说明原因（运维要靠它定位丢文件），实际 %q", lastError)
	}
}

// 有图 = 更慢：这次外呼的超时必须被抬到 60s（配置里的 20s 不够），而且**超时是失败、不是违规** ——
// 调用方必须拿到 ErrTransport（队列据此退避重试），状态与留痕一个字都不动。
func TestImageCallGetsLongerTimeoutAndTimeoutIsNotAVerdict(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("带图帖子", "正文", nil, "pending")
	h.attach(id, hash64("a"), 0)

	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	if h.judge.timeout != 60*time.Second {
		t.Fatalf("有图的这次外呼该给到 60s（ai_config 的 CHECK 上限），实际 %v", h.judge.timeout)
	}

	// 同一个主题再来一次，这次让外呼超时失败。
	h.judge.err = ai.ErrTransport
	if err := h.svc.ReviewTopic(h.ctx, id, "report"); !errors.Is(err, ai.ErrTransport) {
		t.Fatalf("超时必须原样报成可重试失败，实际 %v", err)
	}
	if state, _, source, _ := h.topicState(id); state != "approved" || source == nil || *source != "ai" {
		t.Fatalf("超时不该改状态（上一轮的判定要留着）：state=%q source=%v", state, source)
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
