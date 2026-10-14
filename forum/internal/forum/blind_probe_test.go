package forum

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// blind_probe_test.go —— 独立盲测（HTTP 层）。
//
// 这一轮不信任 review_queue_test.go 的结论：那些用例只走到 service 层，
// **绑定 / 中间件 / 响应包络一次都没被证明过**。本文件全部经真实路由注册表 +
// 真实 JSON 编解码（与 handler_test.go 同一套装配方式）。
//
// 台的一条纪律：**任何请求之前显式声明身份**（as / asGuest）。
// 公开流与收藏页的读一律用 asGuest，读完必须重新声明 —— 否则「游客」会带到下一个请求上，
// 变成一条自己制造的 401（第一版探针就踩了这个坑，见报告）。

// ---- 台 ----

type blindAPI struct {
	t   *testing.T
	h   *harness
	eng *gin.Engine
	mu  sync.Mutex // 保护 cur：并发用例里「声明身份 + 发请求」必须是原子的
	cur *authz.Actor
}

func newBlindAPI(t *testing.T) *blindAPI {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := newHarness(t)
	a := &blindAPI{t: t, h: h, eng: gin.New(), cur: &authz.Actor{}}
	principal := func(c *gin.Context) {
		// 只用这个实例自己的身份；不在这里加锁 —— 它在 req 的临界区里被调用。
		if a.cur.UserID != 0 {
			c.Set(principalKey, a.cur)
		}
		c.Next()
	}
	api := NewHandler(h.svc, func(c *gin.Context) *authz.Actor {
		if v, ok := c.Get(principalKey); ok {
			if act, ok := v.(*authz.Actor); ok {
				return act
			}
		}
		return nil
	})
	// 假 requireLogin 与假 perm 都放行：401/403 的判定必须在 handler/service 里发生，
	// 由注入的中间件替我们判就等于什么都没测（app 层真实中间件的形状另说）。
	api.Register(a.eng.Group("/api/v1"), principal, func(string) gin.HandlerFunc {
		return func(c *gin.Context) { c.Next() }
	})
	return a
}

func (a *blindAPI) as(actor *authz.Actor) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cur = actor
}

func (a *blindAPI) asGuest() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cur = &authz.Actor{}
}

// req 发一次真请求，返回 recorder。body 必须是完整 JSON 串（空串 = 无体）。
func (a *blindAPI) req(method, path, body string) *httptest.ResponseRecorder {
	a.t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	a.eng.ServeHTTP(w, req)
	return w
}

func (a *blindAPI) post(path, body string) *httptest.ResponseRecorder {
	return a.req(http.MethodPost, path, body)
}

// asActorPost 以指定身份发一次 POST：整段（声明身份 + 发请求）在一个临界区里，
// 否则并发用例会互相改对方的身份。**不要在临界区里再拿一次 mu**（Principal 就在 req 里跑）。
func (a *blindAPI) asActorPost(actor *authz.Actor, path, body, expectedUpdatedAt string) *httptest.ResponseRecorder {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cur = actor
	if expectedUpdatedAt != "" {
		body = strings.TrimSuffix(strings.TrimSpace(body), "}") +
			`,"expected_updated_at":"` + expectedUpdatedAt + `"}`
	}
	return a.req(http.MethodPost, path, body)
}

func (a *blindAPI) patch(path, body string) *httptest.ResponseRecorder {
	return a.req(http.MethodPatch, path, body)
}

func (a *blindAPI) decode(w *httptest.ResponseRecorder) map[string]any {
	a.t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		a.t.Fatalf("响应不是 JSON（%d）: %s", w.Code, w.Body.String())
	}
	return m
}

func (a *blindAPI) data(w *httptest.ResponseRecorder) map[string]any {
	a.t.Helper()
	d, ok := a.decode(w)["data"].(map[string]any)
	if !ok {
		a.t.Fatalf("响应包络里没有 data 对象: %s", w.Body.String())
	}
	return d
}

func (a *blindAPI) list(w *httptest.ResponseRecorder) ([]map[string]any, any) {
	a.t.Helper()
	m := a.decode(w)
	arr, ok := m["data"].([]any)
	if !ok {
		a.t.Fatalf("列表响应没有 data 数组: %s", w.Body.String())
	}
	out := make([]map[string]any, 0, len(arr))
	for _, it := range arr {
		obj, ok := it.(map[string]any)
		if !ok {
			a.t.Fatalf("列表项不是对象: %s", w.Body.String())
		}
		out = append(out, obj)
	}
	next, _ := m["next_cursor"]
	return out, next
}

func (a *blindAPI) errCode(w *httptest.ResponseRecorder) string {
	a.t.Helper()
	e, ok := a.decode(w)["error"].(map[string]any)
	if !ok {
		a.t.Fatalf("错误响应没有 error 对象: %s", w.Body.String())
	}
	code, _ := e["code"].(string)
	return code
}

func (a *blindAPI) wantStatus(w *httptest.ResponseRecorder, want int) {
	a.t.Helper()
	if w.Code != want {
		a.t.Fatalf("期望 HTTP %d，实际 %d: %s", want, w.Code, w.Body.String())
	}
}

func (a *blindAPI) wantCode(w *httptest.ResponseRecorder, wantStatus int, wantCode string) {
	a.t.Helper()
	a.wantStatus(w, wantStatus)
	if got := a.errCode(w); got != wantCode {
		a.t.Fatalf("期望错误码 %s，实际 %s: %s", wantCode, got, w.Body.String())
	}
}

// feedIDs 走公开流 GET /api/v1/topics（**游客**视角；调用后当前身份是游客）。
func (a *blindAPI) feedIDs() []string {
	a.t.Helper()
	a.asGuest()
	w := a.req(http.MethodGet, "/api/v1/topics", "")
	a.wantStatus(w, http.StatusOK)
	items, _ := a.list(w)
	out := make([]string, 0, len(items))
	for _, it := range items {
		id, _ := it["id"].(string)
		out = append(out, id)
	}
	return out
}

func (a *blindAPI) state(publicID string) string {
	a.t.Helper()
	var s string
	if err := a.h.pool.QueryRow(a.h.ctx, "SELECT review_state FROM topics WHERE public_id = $1", publicID).Scan(&s); err != nil {
		a.t.Fatalf("回查 review_state 失败: %v", err)
	}
	return s
}

func (a *blindAPI) count(sql string, args ...any) int {
	a.t.Helper()
	return a.h.countRows(a.t, sql, args...)
}

// reviewVersion 取队列项的 updated_at：判定请求必填的「我看到的是哪一版」（新契约 597c4ac）。
// 每次判定都会推新 updated_at，所以**每次判定前都要重新取一次**，不能缓存。
func (a *blindAPI) reviewVersion(id string) string {
	a.t.Helper()
	var at time.Time
	if err := a.h.pool.QueryRow(a.h.ctx,
		"SELECT updated_at FROM topics WHERE public_id = $1", id).Scan(&at); err != nil {
		a.t.Fatalf("取版本号失败: %v", err)
	}
	return at.UTC().Format(time.RFC3339Nano)
}

// review 发一次判定请求：expected_updated_at 是必填项（handler 的信任边界），由本方法补上，
// 用例只写自己要测的那件事。
func (a *blindAPI) review(id, body string) *httptest.ResponseRecorder {
	a.t.Helper()
	body = strings.TrimSuffix(strings.TrimSpace(body), "}") +
		`,"expected_updated_at":"` + a.reviewVersion(id) + `"}`
	return a.post(reviewPath(id), body)
}

func reviewPath(id string) string { return "/api/v1/admin/topics/" + id + "/review" }
func topicPath(id string) string  { return "/api/v1/topics/" + id }

type blindActors struct {
	author   *authz.Actor
	authorID int64
	mod      *authz.Actor
	modID    int64
	roleID   int64
	other    *authz.Actor
}

// blindTopic 建一个分区 + 一个普通（trusted=false）作者：普通作者发的主题留在 pending。
func (a *blindAPI) blindTopic(name string) (*blindActors, string) {
	a.t.Helper()
	roleID := a.h.seedRole("blind-"+name, false)
	a.h.seedBoard("b"+name, 0, false)
	authorID := a.h.seedUser("au"+name, roleID, 1, false)
	author := a.h.actor(authorID, roleID, authz.PermTopicCreate, authz.PermTopicEditOwn, authz.PermTopicDeleteOwn)
	modID := a.h.seedUser("mo"+name, roleID, 1, true)
	mod := a.h.actor(modID, roleID, authz.PermPostReview)
	otherID := a.h.seedUser("ot"+name, roleID, 1, false)
	// other 带 topic.edit.own：app 层的 perm 中间件就是这么放行的（它判的是权限点，
	// 不是这一条主题归谁）。**只有过了中间件才走得到 service 的归属判定** ——
	// 少了这个权限，A3 测的会是中间件的 403，而不是「改别人的帖」那条路径。
	other := a.h.actor(otherID, roleID, authz.PermTopicEditOwn)

	d := a.h.mustTopic(author, CreateTopicInput{BoardSlug: "b" + name, Title: "待审 " + name, ContentMD: "第一版正文"})
	if d.ReviewState != "pending" {
		a.t.Fatalf("前置条件不成立：普通作者发的主题应当在 pending，实际 %q", d.ReviewState)
	}
	return &blindActors{author: author, authorID: authorID, mod: mod, modID: modID, roleID: roleID, other: other}, d.ID
}

// ============================================================
// A. 人工审核队列（全部经 HTTP：真实路由 + 真实绑定 + 真实包络）
// ============================================================

// A1 放行：POST /admin/topics/{id}/review {"action":"approve"} 必须 200，
// 并且改完之后**真的**出现在公开流里 —— 不是只改了数据库那一列。
//
// 旧行为下会红：这一块被补之前没有任何端点能把 pending 变成 approved，
// 路由与 handler 都不存在（落到 NoRoute），放行后的公开流断言永不成立。
func TestBlindApproveMakesItVisibleInPublicFeed(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("a1")

	// 前置：待审帖在公开流里看不见（这就是「AI 拿不准 = 帖子消失」的直接表达）
	if got := a.feedIDs(); len(got) != 0 {
		t.Fatalf("前置不成立：待审帖不该出现在公开流，实际 %v", got)
	}

	// 审核员在队列里能看到它，且走的是列表包络
	a.as(ac.mod)
	w := a.req(http.MethodGet, "/api/v1/admin/topics", "")
	a.wantStatus(w, http.StatusOK)
	items, next := a.list(w)
	if len(items) != 1 || items[0]["id"] != id {
		t.Fatalf("队列应当有且只有这一条，实际 %v", items)
	}
	if next != nil {
		t.Fatalf("只有一条时 next_cursor 必须是 null，实际 %v", next)
	}
	if items[0]["review_state"] != "pending" {
		t.Fatalf("队列项 review_state 应当是 pending，实际 %v", items[0]["review_state"])
	}

	// 放行
	a.as(ac.mod)
	w = a.review(id, `{"action":"approve"}`)
	a.wantStatus(w, http.StatusOK)
	d := a.data(w)
	if d["review_state"] != "approved" {
		t.Fatalf("放行后回执应当是 approved，实际 %v: %s", d["review_state"], w.Body.String())
	}
	// review_source=manual 是「AI 不覆盖人工判定」的那一列
	if src, _ := d["review_source"].(string); src != "manual" {
		t.Fatalf("放行必须落 review_source=manual，实际 %v", d["review_source"])
	}

	// 真的出现在公开流里
	if got := a.feedIDs(); len(got) != 1 || got[0] != id {
		t.Fatalf("放行后公开流应当恰好出现这一条，实际 %v", got)
	}
	// 与数据库真源对账（HTTP 回执说了不算）
	if s := a.state(id); s != "approved" {
		t.Fatalf("数据库里 review_state 应当 approved，实际 %q", s)
	}
}

// A2 拒绝：必须带理由；理由落库；被拒的主题**不进**公开流，只进 rejected 档。
func TestBlindRejectNeedsReasonAndStaysHidden(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("a2")
	a.as(ac.mod)

	// 空理由 / 纯空白：400，且状态不变
	for _, body := range []string{`{"action":"reject"}`, `{"action":"reject","note":"   "}`} {
		w := a.post(reviewPath(id), body)
		a.wantCode(w, http.StatusBadRequest, "common.invalid_input")
		if s := a.state(id); s != "pending" {
			t.Fatalf("失败的判定不该改状态（body=%s），实际 %q", body, s)
		}
	}

	// 带理由：200 + 理由落库 + 不进公开流 + 出现在 rejected 档
	a.as(ac.mod)
	w := a.review(id, `{"action":"reject","note":"来源不明"}`)
	a.wantStatus(w, http.StatusOK)
	d := a.data(w)
	if d["review_state"] != "rejected" {
		t.Fatalf("拒绝后应当是 rejected，实际 %v", d["review_state"])
	}
	if note, _ := d["review_note"].(string); note != "来源不明" {
		t.Fatalf("拒绝理由必须落到回执里，实际 %v", d["review_note"])
	}
	if got := a.feedIDs(); len(got) != 0 {
		t.Fatalf("被拒主题不该出现在公开流，实际 %v", got)
	}
	var note string
	if err := a.h.pool.QueryRow(a.h.ctx, "SELECT COALESCE(review_note,'') FROM topics WHERE public_id = $1", id).Scan(&note); err != nil {
		t.Fatal(err)
	}
	if note != "来源不明" {
		t.Fatalf("拒绝理由必须落库（作者看到的就是它），实际 %q", note)
	}

	a.as(ac.mod)
	w = a.req(http.MethodGet, "/api/v1/admin/topics?state=rejected", "")
	a.wantStatus(w, http.StatusOK)
	items, _ := a.list(w)
	if len(items) != 1 || items[0]["id"] != id {
		t.Fatalf("rejected 档应当能看到它，实际 %v", items)
	}
	a.as(ac.mod)
	w = a.req(http.MethodGet, "/api/v1/admin/topics?state=pending", "")
	items, _ = a.list(w)
	if len(items) != 0 {
		t.Fatalf("pending 档不该还有它，实际 %v", items)
	}
}

// A3 权限：游客 401、登录但无 post.review 403 —— 读与判两条路由都要。
//
// 旧行为下会红：路由不存在时是 404，不是 401/403。
func TestBlindGuardsOnHTTP(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("a3")

	// 游客：actor 为 nil → service 第一道闸 401
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/admin/topics", ""},
		{http.MethodPost, reviewPath(id), `{"action":"approve","expected_updated_at":"2026-10-13T12:00:00Z"}`},
	} {
		a.asGuest()
		w := a.req(c.method, c.path, c.body)
		a.wantCode(w, http.StatusUnauthorized, "common.unauthorized")
	}

	// 登录但没有 post.review：403
	a.as(ac.other)
	w := a.req(http.MethodGet, "/api/v1/admin/topics", "")
	a.wantCode(w, http.StatusForbidden, "common.forbidden")
	a.as(ac.other)
	w = a.post(reviewPath(id), `{"action":"approve","expected_updated_at":"2026-10-13T12:00:00Z"}`)
	a.wantCode(w, http.StatusForbidden, "common.forbidden")

	if s := a.state(id); s != "pending" {
		t.Fatalf("越权判定不该改状态，实际 %q", s)
	}

	// 无权者改别人的正文：404，不是 403（缺陷 D4 已修）。
	//
	// 要测到 requireTopicEdit 那一层，主题必须**先放行**（待审帖对别人本来就不可见，
	// 那条路走的是 TopicRef 的 0 行，测不出归属判定）。放行之后两条路径给同一个 404：
	// 「存在但不归你」与「不存在」不可区分 —— 这正是 errors.go 承诺的「不区分」。
	// 旧行为：service 的 requireTopicEdit 返回 403，等于对一个普通用户承认这条主题存在。
	a.as(ac.mod)
	if w := a.review(id, `{"action":"approve"}`); w.Code != http.StatusOK {
		t.Fatalf("前置放行失败: %d %s", w.Code, w.Body.String())
	}
	a.as(ac.other)
	w = a.patch(topicPath(id), `{"content_md":"我要改别人的帖"}`)
	a.wantCode(w, http.StatusNotFound, "topic.not_found")
	// 内容一个字都没动
	var body string
	if err := a.h.pool.QueryRow(a.h.ctx,
		"SELECT content_md FROM posts p JOIN topics t ON t.id = p.topic_id WHERE t.public_id = $1 AND p.floor = 1",
		id).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != "第一版正文" {
		t.Fatalf("越权编辑不该改到正文，实际 %q", body)
	}

	// 不存在的主题：404（这条走的是 service 的 ErrTopicNotFound）
	a.as(ac.other)
	w = a.patch(topicPath("00000000-0000-7000-8000-000000000000"), `{"content_md":"x"}`)
	a.wantCode(w, http.StatusNotFound, "topic.not_found")
}

// A4 非法参数：state / action / 过长的 note / 损坏的游标 / 不存在的主题。
func TestBlindInvalidParamsOnHTTP(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("a4")
	a.as(ac.mod)

	// state 只有 pending / rejected / all（approved 不是队列的一档）
	for _, st := range []string{"approved", "bogus", "PENDING"} {
		a.as(ac.mod)
		w := a.req(http.MethodGet, "/api/v1/admin/topics?state="+st, "")
		a.wantCode(w, http.StatusBadRequest, "common.invalid_input")
	}
	// 损坏的游标不是「第一页」
	a.as(ac.mod)
	w := a.req(http.MethodGet, "/api/v1/admin/topics?cursor=abc", "")
	a.wantCode(w, http.StatusBadRequest, "common.invalid_input")

	// action 只认 approve / reject；缺 action 连绑定都过不去
	for _, body := range []string{
		`{"action":"publish"}`,
		`{"action":"pending"}`,
		`{"action":""}`,
		`{}`,
	} {
		a.as(ac.mod)
		w := a.review(id, body)
		a.wantCode(w, http.StatusBadRequest, "common.invalid_input")
	}
	if s := a.state(id); s != "pending" {
		t.Fatalf("非法参数不该改状态，实际 %q", s)
	}

	// 缺 expected_updated_at：连绑定都过不去（它是这一层的信任边界，不是可选字段）
	a.as(ac.mod)
	w = a.post(reviewPath(id), `{"action":"approve"}`)
	a.wantCode(w, http.StatusBadRequest, "common.invalid_input")

	// 合法但不存在的 uuid：404（版本号用这条待审帖的，问题不在版本上）
	a.as(ac.mod)
	w = a.post(reviewPath("00000000-0000-7000-8000-000000000000"),
		`{"action":"approve","expected_updated_at":"`+a.reviewVersion(id)+`"}`)
	a.wantCode(w, http.StatusNotFound, "topic.not_found")

	// note 上限 500 字（review_note 是 varchar(500)）
	long := strings.Repeat("好", 501)
	a.as(ac.mod)
	w = a.review(id, `{"action":"reject","note":"`+long+`"}`)
	a.wantCode(w, http.StatusBadRequest, "common.invalid_input")

}

// A5 边界：重复放行 / 反复改判 / 已删主题不可判。
func TestBlindReviewIdempotenceAndDeleted(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("a5")

	// 重复放行：判定本身幂等，不该 409/500
	for i := 0; i < 2; i++ {
		a.as(ac.mod)
		w := a.review(id, `{"action":"approve"}`)
		a.wantStatus(w, http.StatusOK)
		if d := a.data(w); d["review_state"] != "approved" {
			t.Fatalf("第 %d 次放行后应是 approved，实际 %v", i+1, d["review_state"])
		}
	}
	// 放行 → 拒绝 → 再放行：最后一句话说了算
	a.as(ac.mod)
	if w := a.review(id, `{"action":"reject","note":"改判"}`); w.Code != http.StatusOK {
		t.Fatalf("改判失败: %d %s", w.Code, w.Body.String())
	}
	if s := a.state(id); s != "rejected" {
		t.Fatalf("改判后应当是 rejected，实际 %q", s)
	}
	if got := a.feedIDs(); len(got) != 0 {
		t.Fatalf("改判为拒绝后不该还在公开流，实际 %v", got)
	}
	a.as(ac.mod)
	if w := a.review(id, `{"action":"approve"}`); w.Code != http.StatusOK {
		t.Fatalf("再放行失败: %d %s", w.Code, w.Body.String())
	}
	if got := a.feedIDs(); len(got) != 1 {
		t.Fatalf("再放行后公开流应当有 1 条，实际 %v", got)
	}
	// 四次判定（approve / approve / reject / approve）= 四行审计
	if n := a.count("SELECT count(*) FROM audit_logs WHERE action = $1", "topic.review"); n != 4 {
		t.Fatalf("每次判定都要留一行审计，期望 4，实际 %d", n)
	}

	// 已删主题不可判：判 404，且不写审计
	a.as(ac.author)
	if w := a.req(http.MethodDelete, topicPath(id), ""); w.Code != http.StatusNoContent {
		t.Fatalf("删主题应当 204，实际 %d: %s", w.Code, w.Body.String())
	}
	// 先取一次版本号（已删主题取不到也没关系，404 的判定在服务端）
	ver := a.reviewVersion(id)
	a.as(ac.mod)
	w := a.post(reviewPath(id), `{"action":"approve","expected_updated_at":"`+ver+`"}`)
	a.wantCode(w, http.StatusNotFound, "topic.not_found")
	if n := a.count("SELECT count(*) FROM audit_logs WHERE action = $1", "topic.review"); n != 4 {
		t.Fatalf("对已删主题的判定不该留审计，期望仍为 4，实际 %d", n)
	}
}

// A6 边界：队列游标翻页。6 条待审，limit=2 → 三页、不重不漏。
func TestBlindQueueCursorPaging(t *testing.T) {
	a := newBlindAPI(t)
	roleID := a.h.seedRole("blind-a6", false)
	a.h.seedBoard("ba6", 0, false)
	authorID := a.h.seedUser("aua6", roleID, 1, false)
	author := a.h.actor(authorID, roleID, authz.PermTopicCreate)
	mod := a.h.actor(a.h.seedUser("moa6", roleID, 1, true), roleID, authz.PermPostReview)

	var want []string
	for i := 0; i < 6; i++ {
		d := a.h.mustTopic(author, CreateTopicInput{BoardSlug: "ba6", Title: fmt.Sprintf("t%d", i), ContentMD: "x"})
		want = append(want, d.ID)
		a.h.clk.T = a.h.clk.T.Add(1e9) // 每条相隔 1s，排序键 (created_at, id) 才有区分度
	}

	got := []string{}
	cursor := ""
	for page := 0; page < 3; page++ {
		path := "/api/v1/admin/topics?limit=2"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		a.as(mod)
		w := a.req(http.MethodGet, path, "")
		a.wantStatus(w, http.StatusOK)
		items, next := a.list(w)
		if len(items) > 2 {
			t.Fatalf("第 %d 页超过 limit：%d 条", page+1, len(items))
		}
		for _, it := range items {
			got = append(got, it["id"].(string))
		}
		if next == nil {
			break
		}
		nextStr, _ := next.(string)
		if nextStr == "" || nextStr == cursor {
			t.Fatalf("游标没有前进：%q", nextStr)
		}
		cursor = nextStr
	}
	if len(got) != len(want) {
		t.Fatalf("翻页漏行：期望 %d 条，实际 %d（%v）", len(want), len(got), got)
	}
	seen := map[string]bool{}
	for _, id := range got {
		if seen[id] {
			t.Fatalf("翻页重复：%s（%v）", id, got)
		}
		seen[id] = true
	}
	for _, id := range want {
		if !seen[id] {
			t.Fatalf("翻页漏了 %s（%v）", id, got)
		}
	}
	// 队列按 created_at DESC：最新的一条在第一个
	if got[0] != want[len(want)-1] {
		t.Fatalf("队列应当最新在前，期望首条 %s，实际 %s", want[len(want)-1], got[0])
	}
}

// A7 边界：两个审核员同时判同一条。至少一次投递 + 幂等：两个请求都该成功。
func TestBlindConcurrentReviews(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("a7")
	mod2 := a.h.actor(a.h.seedUser("moa7b", ac.roleID, 1, true), ac.roleID, authz.PermPostReview)

	// 两个 worker 共用这一个 engine（中间件闭包只认本实例的 cur；换了实例就换成了别人的身份）。
	mods := []*authz.Actor{ac.mod, mod2}
	// 两个审核员读到的是同一版（并发判定是「同时判同一条」）
	ver := a.reviewVersion(id)
	codes := make([]int, len(mods))
	bodies := make([]string, len(mods))
	var wg sync.WaitGroup
	for i := range mods {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := a.asActorPost(mods[i], reviewPath(id), `{"action":"approve"}`, ver)
			codes[i], bodies[i] = w.Code, w.Body.String()
		}(i)
	}
	wg.Wait()

	for i := range codes {
		if codes[i] != http.StatusOK {
			t.Fatalf("并发判定第 %d 个请求应当 200，实际 %d: %s", i+1, codes[i], bodies[i])
		}
	}
	if s := a.state(id); s != "approved" {
		t.Fatalf("并发判定后应当是 approved，实际 %q", s)
	}
	if got := a.feedIDs(); len(got) != 1 {
		t.Fatalf("并发放行后公开流应当有 1 条，实际 %v", got)
	}
	// 两次判定 = 两行审计（通知的去重不该把判定吞掉）
	if n := a.count("SELECT count(*) FROM audit_logs WHERE action = $1", "topic.review"); n != 2 {
		t.Fatalf("两次并发判定应当有 2 行审计，实际 %d", n)
	}
}

// ============================================================
// B. 编辑帖子正文（全部经 HTTP：真实路由 + 绑定 + 包络）
// ============================================================

// B1 PATCH /topics/{id} 带 content_md 必须 200，并且主题回到待审（从公开流消失）。
//
// 旧行为下会红：ResetTopicReview 此前写的是 topics 表**不存在**的两列
// （ai_reviewed / ai_review_note）—— PATCH 带 content_md 必然 500、整个事务回滚。
func TestBlindEditContentViaHTTPResetsReview(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("b1")

	a.as(ac.mod)
	if w := a.review(id, `{"action":"approve"}`); w.Code != http.StatusOK {
		t.Fatalf("放行失败: %d %s", w.Code, w.Body.String())
	}
	if got := a.feedIDs(); len(got) != 1 {
		t.Fatalf("放行后公开流应当有 1 条，实际 %v", got)
	}

	// 改正文
	a.as(ac.author)
	w := a.patch(topicPath(id), `{"content_md":"第二版正文"}`)
	a.wantStatus(w, http.StatusOK)
	if m := a.decode(w); m["data"] == nil {
		t.Fatalf("PATCH 应当回 {data:{...}}，实际 %s", w.Body.String())
	}

	// 回到待审
	if s := a.state(id); s != "pending" {
		t.Fatalf("改过正文必须回到 pending，实际 %q", s)
	}
	// 四列一起清（不能留着上一版内容的判定）
	var source, note, by string
	var at *string
	if err := a.h.pool.QueryRow(a.h.ctx,
		"SELECT COALESCE(review_source,''), COALESCE(review_note,''), COALESCE(reviewed_by::text,''), reviewed_at::text FROM topics WHERE public_id = $1",
		id).Scan(&source, &note, &by, &at); err != nil {
		t.Fatal(err)
	}
	if source != "" || note != "" || by != "" || at != nil {
		t.Fatalf("回到待审必须清掉上一版判定：source=%q note=%q by=%q at=%v", source, note, by, at)
	}
	// 1 楼正文真的换了
	var body string
	if err := a.h.pool.QueryRow(a.h.ctx,
		"SELECT content_md FROM posts p JOIN topics t ON t.id = p.topic_id WHERE t.public_id = $1 AND p.floor = 1", id).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != "第二版正文" {
		t.Fatalf("1 楼正文应当被替换，实际 %q", body)
	}
	// 内容变了 → 从公开流消失，等复审
	if got := a.feedIDs(); len(got) != 0 {
		t.Fatalf("回到待审后不该还在公开流，实际 %v", got)
	}

	// 复审放行 → 又可见
	a.as(ac.mod)
	if w := a.review(id, `{"action":"approve"}`); w.Code != http.StatusOK {
		t.Fatalf("复审放行失败: %d %s", w.Code, w.Body.String())
	}
	if got := a.feedIDs(); len(got) != 1 {
		t.Fatalf("复审放行后公开流应当有 1 条，实际 %v", got)
	}
}

// B2 只改标题不重置审核：分类问题不该让一篇正常帖子掉出可见状态。
func TestBlindTitleOnlyEditKeepsApproved(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("b2")

	a.as(ac.mod)
	if w := a.review(id, `{"action":"approve"}`); w.Code != http.StatusOK {
		t.Fatalf("放行失败: %d %s", w.Code, w.Body.String())
	}

	a.as(ac.author)
	w := a.patch(topicPath(id), `{"title":"改过的标题"}`)
	a.wantStatus(w, http.StatusOK)
	if s := a.state(id); s != "approved" {
		t.Fatalf("只改标题不该重置审核，实际 %q", s)
	}
	if got := a.feedIDs(); len(got) != 1 {
		t.Fatalf("只改标题不该掉出公开流，实际 %v", got)
	}
	var title string
	if err := a.h.pool.QueryRow(a.h.ctx, "SELECT title FROM topics WHERE public_id = $1", id).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "改过的标题" {
		t.Fatalf("标题没改到，实际 %q", title)
	}
}

// B3 改正文的参数边界：空 / 纯空白正文 400，失败不改审核态。
func TestBlindEditContentBoundaries(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("b3")
	a.as(ac.mod)
	if w := a.review(id, `{"action":"approve"}`); w.Code != http.StatusOK {
		t.Fatalf("放行失败: %d %s", w.Code, w.Body.String())
	}

	a.as(ac.author)
	for _, body := range []string{`{"content_md":""}`, `{"content_md":"   "}`} {
		w := a.patch(topicPath(id), body)
		a.wantCode(w, http.StatusBadRequest, "common.invalid_input")
	}
	if s := a.state(id); s != "approved" {
		t.Fatalf("失败的编辑不该改审核态，实际 %q", s)
	}
}

// X1（自己找的边界，缺陷 D3 已修）：**格式非法的 uuid 是 400，不是 500**。
//
// 旧行为：路径参数被原样送进 SQL 的 uuid 比较，PostgreSQL 22P02 直接冒到 HTTP 层 ——
// 判定与 PATCH 两条路径都是 500 common.internal。修法是在 httpx 的路径参数闸统一挡下
// （forum/internal/forum 的 Register 上挂一次），所以这里断言的是「任何非 uuid 的 {id}」。
//
// 它值一条回归资产：这条闸一旦被摘掉（或新路由绕开它），这里立刻红回 500。
func TestBlindMalformedUUIDIsFourHundredNotFiveHundred(t *testing.T) {
	a := newBlindAPI(t)
	ac, _ := a.blindTopic("x1")

	a.as(ac.mod)
	w := a.post(reviewPath("not-a-uuid"), `{"action":"approve","expected_updated_at":"2026-10-13T12:00:00Z"}`)
	a.wantCode(w, http.StatusBadRequest, "common.invalid_input")

	// PATCH 同一条路径（缺陷是在这条上面被发现的）
	a.as(ac.author)
	w = a.patch("/api/v1/topics/not-a-uuid", `{"content_md":"x"}`)
	a.wantCode(w, http.StatusBadRequest, "common.invalid_input")

	// 读路径同一条闸：GET /topics/{id} 也必须是 400，不能是 500
	a.asGuest()
	w = a.req(http.MethodGet, "/api/v1/topics/not-a-uuid", "")
	a.wantCode(w, http.StatusBadRequest, "common.invalid_input")

	// 合法的 uuid 但不存在：仍然 404（这条闸不该把 404 变 400）
	a.asGuest()
	w = a.req(http.MethodGet, "/api/v1/topics/00000000-0000-7000-8000-000000000000", "")
	a.wantCode(w, http.StatusNotFound, "topic.not_found")
}

// X2（自己找的边界）：**待审主题从收藏页漏出来**。
//
// 真源：pgsql/topics.go 的 ListTopics 是 visibility='normal' AND review_state='approved'，
// 而 ListTopicsByBookmark 只有 (t.visibility='normal' OR t.author_id=$1) —— 没有 review_state 谓词。
// 于是一条待审 / 被拒的主题只要被作者收藏，就会从收藏页露出来。
// 这不是「人工审核队列」的验收项，而是同一批可见性谓词里的不一致，故单列。
func TestBlindPendingLeaksThroughBookmarks(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("x2")

	if got := a.feedIDs(); len(got) != 0 {
		t.Fatalf("前置不成立：待审帖不该出现在公开流，实际 %v", got)
	}

	// 作者收藏自己的待审帖
	a.as(ac.author)
	w := a.req(http.MethodPut, topicPath(id)+"/bookmark", "")
	if w.Code != http.StatusOK {
		t.Fatalf("收藏应当 200，实际 %d: %s", w.Code, w.Body.String())
	}
	a.as(ac.author)
	w = a.req(http.MethodGet, "/api/v1/me/bookmarks", "")
	a.wantStatus(w, http.StatusOK)
	items, _ := a.list(w)
	if len(items) != 0 {
		t.Fatalf("待审主题不该出现在收藏页（可见性谓词应与公开流一致），实际 %v", items)
	}
}

// X3（自己找的边界）：**被 AI 复核隐藏的主题，人工放行之后仍然不可见**。
//
// 真源：aireview/sql.go 的复审路径会把 topics.visibility 写成 'hidden'；
// 而全仓写 visibility 的地方只有三处：AI 写 hidden、DeleteTopic 写 deleted、
// InsertTopic 用默认值 normal —— **没有任何路径能把它改回 normal**。
// 于是「AI 先隐藏、人来放行」的帖子：review_state=approved、作者收到「通过」通知，
// 但在首页 / 分区页 / 公开搜索里都不存在（公开流的谓词是 visibility='normal' AND review_state='approved'）。
func TestBlindHiddenTopicStaysInvisibleAfterHumanApprove(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("x3")

	// 复现 AI 复审 reject 的落点：隐藏但没判死（review_state 仍是 pending）
	if _, err := a.h.pool.Exec(a.h.ctx,
		"UPDATE topics SET visibility = 'hidden', review_note = 'AI 复核不通过' WHERE public_id = $1", id); err != nil {
		t.Fatal(err)
	}
	if s := a.state(id); s != "pending" {
		t.Fatalf("前置：review_state 应当仍是 pending，实际 %q", s)
	}

	// 人工放行
	a.as(ac.mod)
	w := a.review(id, `{"action":"approve"}`)
	a.wantStatus(w, http.StatusOK)
	if d := a.data(w); d["review_state"] != "approved" {
		t.Fatalf("放行后 review_state 应当 approved，实际 %v", d["review_state"])
	}

	// 放行之后：**必须能在公开流里看到它**
	if got := a.feedIDs(); len(got) != 1 || got[0] != id {
		var vis, st string
		if err := a.h.pool.QueryRow(a.h.ctx,
			"SELECT visibility, review_state FROM topics WHERE public_id = $1", id).Scan(&vis, &st); err != nil {
			t.Fatal(err)
		}
		t.Fatalf("人工放行后公开流应当能看到它，实际 %v（visibility=%q review_state=%q）—— "+
			"没有任何路径能把 visibility 改回 normal", got, vis, st)
	}
}

// X4（自己找的边界）：**审核员读到的是旧状态，作者在判定前改了正文**。
//
// 队列项是「读一次 → 判一次」的两步操作：审核员看到的是 pending，点通过时内容可能已经
// 换了一版（PATCH 带 content_md 会打回 pending 并换正文）。判定必须基于「刚读到的那个状态」，
// 否则等于放行一份没人看过的内容。
func TestBlindReviewAfterAuthorEditedIsConflict(t *testing.T) {
	a := newBlindAPI(t)
	ac, id := a.blindTopic("x4")

	// 审核员读到这条（pending）
	a.as(ac.mod)
	w := a.req(http.MethodGet, "/api/v1/admin/topics", "")
	a.wantStatus(w, http.StatusOK)
	items, _ := a.list(w)
	if len(items) != 1 || items[0]["review_state"] != "pending" {
		t.Fatalf("前置：队列里应当有一条 pending，实际 %v", items)
	}

	// 作者在审核员点下判定之前改了正文（→ 回 pending、内容换了一版）
	a.as(ac.author)
	if w := a.patch(topicPath(id), `{"content_md":"第三版正文"}`); w.Code != http.StatusOK {
		t.Fatalf("改正文应当 200，实际 %d: %s", w.Code, w.Body.String())
	}

	// 基于旧读的放行必须被拒（冲突），否则新内容会被直接标成 approved
	a.as(ac.mod)
	w = a.post(reviewPath(id), `{"action":"approve"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("内容在判定前变过时，判定应当被拒（冲突），实际 %d: %s", w.Code, w.Body.String())
	}
	if s := a.state(id); s != "pending" {
		t.Fatalf("冲突的判定不该改状态，实际 %q", s)
	}
	if got := a.feedIDs(); len(got) != 0 {
		t.Fatalf("没人看过的新内容不该进公开流，实际 %v", got)
	}
}
