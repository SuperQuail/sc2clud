package aireview_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// D63(b)：审核历史读口的用例。review_events 在 0020 就有了、也一直在写（AI 与人工判定都落），
// 缺的只有「列表读口」——所以这里的判定断言是「写进去的能原样读出来」，顺带钉住四件事：
// 包络形状、权限点、筛选与游标、以及「AI 行没有 actor、人工行有」（审计同一口径）。

// reviewEvent 是手工造一次判定（不外呼、不等 worker）：ListEvents 只读表。
func (h *harness) reviewEvent(topicID int64, trigger, source, verdict, reason string, at time.Time) {
	h.t.Helper()
	var actorID any
	if source == "manual" {
		actorID = h.authorID
	}
	if _, err := h.pool.Exec(h.ctx,
		`INSERT INTO review_events (topic_id, trigger, source, verdict, reason, categories, model, latency_ms,
		       image_count, image_skipped, actor_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 8, 9, 1, $8, $9)`,
		topicID, trigger, source, verdict, reason,
		[]string{"偽装"}, "fake-model", actorID, at); err != nil {
		h.t.Fatalf("造判定事件: %v", err)
	}
}

// getJSON 是 GET 版的 postJSON（preview_test.go）：解 {data, next_cursor} 包络。
func getJSON(t *testing.T, r *gin.Engine, path string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	if w.Body.Len() > 0 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("回执不是 JSON（%d）: %s", w.Code, w.Body.String())
		}
	}
	return w.Code, out
}

// eventsGET 打 GET 端点。perm 的取值分三档（照 newTestEngine 的表达法）：
//
//	"-"      —— 一个头都不带（用例里的「没登录」，401 由 perm 中间件与 handler.require 双双兜住）；
//	""       —— 带了身份但没有权限点（403）；
//	"post.review" / "site.setting" —— 身份 + 对应权限点。
func (h *harness) eventsGET(path, perm string) (int, map[string]any) {
	h.t.Helper()
	r := newTestEngine(h)
	headers := map[string]string{}
	if perm != "-" {
		headers["X-Test-Actor"] = "1"
	}
	if perm != "" && perm != "-" {
		headers["X-Test-Perm"] = perm
	}
	return getJSON(h.t, r, path, headers)
}

// mustJSONs 把解开的包络再串回去，让下面的 Unmarshal 断言按**JSON 字段名**逐字判。
func mustJSONs(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestEventsEndpointShapeAndOrdering(t *testing.T) {
	h := newHarness(t)
	idA := h.topic("AI 说通过的帖子", "内容一", nil, "approved")
	idB := h.topic("AI 转人工的帖子", "内容二", nil, "pending")
	var pubA, pubB string
	if err := h.pool.QueryRow(h.ctx, `SELECT public_id FROM topics WHERE id = $1`, idA).Scan(&pubA); err != nil {
		t.Fatalf("读 public_id: %v", err)
	}
	if err := h.pool.QueryRow(h.ctx, `SELECT public_id FROM topics WHERE id = $1`, idB).Scan(&pubB); err != nil {
		t.Fatal(err)
	}
	// 三次判定：两 AI 一人工（三个 trigger 值域都落到三条里；人工行带 actor）。
	h.reviewEvent(idA, "create", "ai", "approve", "没问题", time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC))
	h.reviewEvent(idB, "create", "ai", "review", "拿不准", time.Date(2026, 10, 14, 10, 0, 0, 0, time.UTC))
	h.reviewEvent(idA, "report", "manual", "reject", "人工说不行", time.Date(2026, 10, 14, 11, 0, 0, 0, time.UTC))

	// 权限：没登录 401 → 有身份但错档（site.setting）403 → 带对 post.review 200。
	if code, _ := h.eventsGET("/api/v1/admin/ai/events", "-"); code != http.StatusUnauthorized {
		t.Fatalf("没登录该 401，实际 %d", code)
	}
	if code, _ := h.eventsGET("/api/v1/admin/ai/events", authz.PermSiteSetting); code != http.StatusForbidden {
		t.Fatalf("配置那一档（site.setting）不是这个屏的受众，该 403，实际 %d", code)
	}
	code, out := h.eventsGET("/api/v1/admin/ai/events", authz.PermPostReview)
	if code != http.StatusOK {
		t.Fatalf("该 200，实际 %d：%s", code, mustJSONs(out))
	}
	data, ok := out["data"].([]any)
	if !ok || len(data) != 3 {
		t.Fatalf("包络 data 该是 3 条事件，实际 %s", mustJSONs(out))
	}
	if out["next_cursor"] != nil {
		t.Fatalf("一页就装下 3 条时 next_cursor 必须是 null，实际 %v", out["next_cursor"])
	}
	for i, want := range []struct {
		source, verdict, topicID string
		actor                    bool
	}{
		{"manual", "reject", pubA, true},
		{"ai", "review", pubB, false},
		{"ai", "approve", pubA, false},
	} {
		var row struct {
			ID           int64    `json:"id"`
			CreatedAt    string   `json:"created_at"`
			TopicID      string   `json:"topic_id"`
			TopicTitle   string   `json:"topic_title"`
			Trigger      string   `json:"trigger"`
			Source       string   `json:"source"`
			Verdict      string   `json:"verdict"`
			Reason       string   `json:"reason"`
			Categories   []string `json:"categories"`
			Model        string   `json:"model"`
			LatencyMS    int      `json:"latency_ms"`
			ImageCount   int      `json:"image_count"`
			ImageSkipped int      `json:"image_skipped"`
			Actor        *struct {
				ID       string `json:"id"`
				Handle   string `json:"handle"`
				Nickname string `json:"nickname"`
			} `json:"actor"`
		}
		if err := json.Unmarshal([]byte(mustJSONs(data[i])), &row); err != nil {
			t.Fatalf("解一行: %v", err)
		}
		if row.Source != want.source || row.Verdict != want.verdict {
			t.Fatalf("第 %d 行该是 %v/%v，实际 source=%s verdict=%s", i, want.source, want.verdict, row.Source, row.Verdict)
		}
		if row.TopicID != want.topicID {
			t.Fatalf("topic_id 该是对外 public_id %q，实际 %q", want.topicID, row.TopicID)
		}
		if row.TopicTitle == "" {
			t.Fatal("topic_title 不能是空：屏上要靠它认行")
		}
		if row.Model != "fake-model" || row.LatencyMS != 8 || row.ImageCount != 9 || row.ImageSkipped != 1 {
			t.Fatalf("记录列没原样读出：model=%s lat=%d image=%d skipped=%d", row.Model, row.LatencyMS, row.ImageCount, row.ImageSkipped)
		}
		if want.actor {
			if row.Actor == nil || row.Actor.Handle != h.authorHandle {
				t.Fatalf("人工行该带判定人（%s），实际 %+v", h.authorHandle, row.Actor)
			}
		} else if row.Actor != nil {
			t.Fatalf("AI 行不该有 actor，实际 %+v", row.Actor)
		}
		if len(row.Categories) != 1 || row.Categories[0] != "偽装" {
			t.Fatalf("categories 该原样读出（TEXT[]），实际 %v", row.Categories)
		}
		if row.Trigger == "" || row.Reason == "" || row.CreatedAt == "" {
			t.Fatal("trigger/created_at/reason 三个字段是屏上的主角，不能空")
		}
	}
}

// 分页与筛选的语义：cursor 只回传不解释；筛选两根轴的值域在 SQL 之前先 400（不靠 CHECK 撞 23514 —— D70 的教训）。
func TestEventsPaginationAndFilters(t *testing.T) {
	h := newHarness(t)
	id := h.topic("一帖多判的帖子", "内容", nil, "approved")
	for i := 0; i < 3; i++ {
		h.reviewEvent(id, "create", "ai", "approve", "没问题", time.Date(2026, 10, 14, 9, i, 0, 0, time.UTC))
	}
	h.reviewEvent(id, "report", "manual", "reject", "人工复核不让过", time.Date(2026, 10, 14, 10, 0, 0, 0, time.UTC))

	// limit=1 → 每页 1 条 + next_cursor；一路翻到底不重不漏（按 id 查重：AI 三件的 reason 相同，按理由查重会自误）。
	seen := map[int64]bool{}
	cursor := ""
	count := 0
	for page := 0; ; page++ {
		path := "/api/v1/admin/ai/events?limit=1"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		code, out := h.eventsGET(path, authz.PermPostReview)
		if code != http.StatusOK {
			t.Fatalf("第 %d 页该 200，实际 %d", page, code)
		}
		data, _ := out["data"].([]any)
		if len(data) != 1 {
			t.Fatalf("limit=1 下每页该恰 1 条，实际 %s", mustJSONs(out))
		}
		var row struct {
			ID     int64  `json:"id"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal([]byte(mustJSONs(data[0])), &row); err != nil {
			t.Fatal(err)
		}
		if seen[row.ID] {
			t.Fatalf("第 %d 页翻回了看过的行（id=%d）", page, row.ID)
		}
		seen[row.ID] = true
		count++
		next, _ := out["next_cursor"].(string)
		if next == "" {
			break
		}
		cursor = next
	}
	if count != 4 {
		t.Fatalf("4 行该翻 4 页拿全，实际 %d", count)
	}

	// 筛选：source=ai 只剩 3 条 AI 行；verdict=reject 只剩人工那一行。
	// expectCount 用「source=ai → 3、verdict=reject → 1」这样的实际入库分布，不硬写 1。
	for _, tc := range []struct {
		q     string
		count int
		same  string
	}{
		{"source=ai", 3, "没问题"},
		{"verdict=reject", 1, "人工复核不让过"},
	} {
		code, out := h.eventsGET("/api/v1/admin/ai/events?"+tc.q, authz.PermPostReview)
		if code != http.StatusOK {
			t.Fatalf("筛选 %s 该 200，实际 %d", tc.q, code)
		}
		data, _ := out["data"].([]any)
		if len(data) != tc.count {
			t.Fatalf("筛选 %s 该剩 %d 行，实际 %s", tc.q, tc.count, mustJSONs(out))
		}
		for _, e := range data {
			var row struct {
				Source string `json:"source"`
				Reason string `json:"reason"`
			}
			if err := json.Unmarshal([]byte(mustJSONs(e)), &row); err != nil {
				t.Fatal(err)
			}
			if row.Reason != tc.same {
				t.Fatalf("筛选 %s 的每行该都是 %q，实际 %q", tc.q, tc.same, row.Reason)
			}
		}
	}
	// 坏参数全 400：值域错误、解码失败、伪游标（base64 对但 k 不可解析时间）。
	badJSON, _ := json.Marshal(map[string]any{"k": "not-a-time", "id": 1})
	for _, q := range []string{"verdict=ok", "source=web", "cursor=!!!", "cursor=" + base64.RawURLEncoding.EncodeToString(badJSON)} {
		if code, _ := h.eventsGET("/api/v1/admin/ai/events?"+q, authz.PermPostReview); code != http.StatusBadRequest {
			t.Fatalf("bad query %q 该 400，实际 %d", q, code)
		}
	}
}
