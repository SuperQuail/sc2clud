package aireview_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"forum/internal/aireview"
	"forum/internal/authz"
	"forum/internal/platform/ai"
)

// D33①②③④：审核屏要能看见「真正发给模型的那一份」，连通测试的样例要能看见也能改。
//
// 三条断言各自钉住一件**只可能由服务端回答**的事：
//   ① 预览里的 system/user 两段与真判定发出去的那两段**同一份组装代码**（拿 fakeJudge 收到的东西逐字比）；
//   ② 连通测试的默认样例从服务端读得到，且能把**这一次**的样例换掉再测（临时覆盖，不落库）；
//   ③ 有图的帖子：正文里的 Markdown 字面量进 payload，而**图片字节不进** —— 并且后端把
//      「这篇主题挂着几张图」也一起报出来（只数正文里的 ![..] 会漏掉图集里的图，那正是它要防的错觉）。
//
// 先红：这三条在加 preview.go 之前根本编译不过（Payload / PayloadInput / DefaultProbeSample 都不存在）；
// 实现之后把 Preview 换回「自己拼一份」再跑，① 会红在文本不一致上。

// withImage 给一篇主题挂上一张真图（images 全站一张表，正文引用与否是两件事）。
func (h *harness) withImage(topicID int64, hash string) {
	h.t.Helper()
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO images (hash, size, mime, width, height) VALUES ($1, 1024, 'image/png', 800, 600)", hash); err != nil {
		h.t.Fatalf("建图片: %v", err)
	}
	var postID int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM posts WHERE topic_id = $1 AND floor = 1", topicID).Scan(&postID); err != nil {
		h.t.Fatalf("读 1 楼: %v", err)
	}
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO topic_images (topic_id, post_id, image_hash, sort) VALUES ($1, $2, $3, 0)",
		topicID, postID, hash); err != nil {
		h.t.Fatalf("挂配图: %v", err)
	}
}

// hash64 造一个能过 ck_images_hash_fmt（^[0-9a-f]{64}$）的哈希。
func hash64(ch string) string { return strings.Repeat(ch, 64) }

// titleOf 读回标题（断言里要拼出 user_title 的期望值）。
func (h *harness) titleOf(id int64) string {
	h.t.Helper()
	var title string
	if err := h.pool.QueryRow(h.ctx, "SELECT title FROM topics WHERE id = $1", id).Scan(&title); err != nil {
		h.t.Fatalf("读标题: %v", err)
	}
	return title
}

// ① 预览与真发出去的那一份同源：文本逐字相等、分段拼得回原文。
func TestPreviewMatchesWhatIsActuallySent(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	body := "看图：\n\n![封面](/img/" + hash64("a") + ")\n\n正文若干。"
	id := h.topic("带图的帖子", body, nil, "pending")
	h.withImage(id, hash64("b"))

	pv, err := h.svc.Preview(h.ctx, aireview.PayloadInput{TopicID: id, Trigger: "create"})
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if err := h.svc.ReviewTopic(h.ctx, id, "create"); err != nil {
		t.Fatalf("ReviewTopic: %v", err)
	}
	if h.judge.calls != 1 {
		t.Fatalf("该外呼一次，实际 %d", h.judge.calls)
	}
	if pv.System != h.judge.prompt {
		t.Fatalf("预览的 system 与真发出去的不是同一份：\n预览 %q\n实际 %q", pv.System, h.judge.prompt)
	}
	if got, want := pv.UserPrefix+pv.UserTitle+"\n\n"+pv.UserBody, h.judge.text; got != want {
		t.Fatalf("预览的 user 拼起来与真发出去的不是同一份：\n得到 %q\n想要 %q", got, want)
	}
	// 分段要**拼得回**原文：标题与正文各自成段，前端才敢把「哪一段是标题」标出来。
	if pv.UserTitle != "标题："+h.titleOf(id) {
		t.Fatalf("user_title=%q", pv.UserTitle)
	}
	if pv.UserBody != "正文：\n"+body {
		t.Fatalf("user_body=%q", pv.UserBody)
	}
	// 图片：Markdown 字面量在文本里（模型唯一看得到的痕迹），图片字段一个都没有。
	if !strings.Contains(pv.UserBody, "![封面](/img/"+hash64("a")+")") {
		t.Fatal("正文里的图片 Markdown 没进预览")
	}
	for _, s := range []string{pv.System, pv.UserTitle, pv.UserBody} {
		if strings.Contains(s, "image_url") || strings.Contains(s, "data:image") {
			t.Fatal("预览里出现了图片字段：本域不发图（D25②）")
		}
	}
}

// ③ 图片那条：正文里的 ![..] 与**图集里挂着的图**是两件事，各自都要能看见 —— 这就是「可验证」的全部含义。
func TestPreviewReportsImagesTruthfully(t *testing.T) {
	h := newHarness(t)
	lit := "![插图](/img/" + hash64("a") + ")"
	both := h.topic("两种都有", "看图 "+lit+" 完。", nil, "pending")
	h.withImage(both, hash64("b"))
	only := h.topic("只有图集", "正文里没有图片标记。", nil, "pending")
	h.withImage(only, hash64("c"))
	clean := h.topic("没有图", "纯文本。", nil, "pending")

	cases := []struct {
		name     string
		id       int64
		literal  bool
		attached int
	}{
		{"正文有字面量 + 图集有图", both, true, 1},
		{"只有图集、正文没标记", only, false, 1},
		{"没有图", clean, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pv, err := h.svc.Preview(h.ctx, aireview.PayloadInput{TopicID: tc.id, Trigger: "create"})
			if err != nil {
				t.Fatalf("Preview: %v", err)
			}
			if pv.HasImageMarkdown != tc.literal {
				t.Fatalf("has_image_markdown=%v，想要 %v", pv.HasImageMarkdown, tc.literal)
			}
			if pv.ImageAttachmentCount != tc.attached {
				t.Fatalf("image_attachment_count=%d，想要 %d", pv.ImageAttachmentCount, tc.attached)
			}
		})
	}
}

// 举报复核那一档：前缀是**服务端**加的，预览要单列出来（混进正文里，审核员会以为作者自己写了那句话）。
func TestPreviewReportPrefixIsSeparateAndMatchesSend(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	id := h.topic("被举报的帖子", "正文内容", nil, "pending")
	if _, err := h.pool.Exec(h.ctx,
		"INSERT INTO reports (public_id, target_type, target_id, reporter_id, reason, state) VALUES ($1::uuid, 'topic', $2, $3, 'spam', 'open')",
		uuid.New(), id, h.authorID); err != nil {
		t.Fatalf("建举报: %v", err)
	}

	pv, err := h.svc.Preview(h.ctx, aireview.PayloadInput{TopicID: id, Trigger: "report"})
	if err != nil {
		t.Fatalf("Preview(report): %v", err)
	}
	if pv.OpenReports != 1 {
		t.Fatalf("open_reports=%d，想要 1（sqlSubject 的未处理举报数）", pv.OpenReports)
	}
	if !strings.HasPrefix(pv.UserPrefix, "【举报复核】该帖已被 1 人举报") {
		t.Fatalf("user_prefix=%q，举报复核那一行没单列出来", pv.UserPrefix)
	}
	if strings.Contains(pv.UserBody, "举报复核") {
		t.Fatal("举报前缀混进了正文那一段：审核员会以为作者自己写了那句话")
	}
	if err := h.svc.ReviewTopic(h.ctx, id, "report"); err != nil {
		t.Fatalf("ReviewTopic(report): %v", err)
	}
	if got := pv.UserPrefix + pv.UserTitle + "\n\n" + pv.UserBody; got != h.judge.text {
		t.Fatalf("举报复核这一档预览与真发的不是同一份：\n得到 %q\n想要 %q", got, h.judge.text)
	}
}

// ② 连通测试的样例：默认从服务端读得到，且能把**这一次**的样例换掉再测（临时覆盖，不落库）。
func TestProbeSampleIsReadableAndOverridable(t *testing.T) {
	h := newHarness(t)
	h.putKey()

	pv, err := h.svc.PreviewProbe(h.ctx, "")
	if err != nil {
		t.Fatalf("PreviewProbe: %v", err)
	}
	want := aireview.DefaultProbeSample
	if pv.Source != "probe" || pv.UserText != want {
		t.Fatalf("默认样例 source=%q user_text=%q，想要 probe / %q", pv.Source, pv.UserText, want)
	}
	if pv.UserTitle != "" || pv.UserBody != "" || pv.UserPrefix != "" {
		t.Fatal("连通测试发的就是样例本身，不该被拆成标题/正文两段")
	}
	if pv.System == "" {
		t.Fatal("预览必须带上将要用的 system 提示词")
	}

	// 覆盖：这一次发出去的必须是编辑后的那份
	custom := "标题：我改过的样例\n\n正文：这一段是我临时写的，用来试一个边界。"
	if _, err := h.svc.Test(h.ctx, custom); err != nil {
		t.Fatalf("Test(自定义样例): %v", err)
	}
	if h.judge.text != custom {
		t.Fatalf("连通测试发的是 %q，想要我编辑过的 %q", h.judge.text, custom)
	}

	// 空串 = 用默认样例：不传样例的老调用方行为一个字都不该变
	if _, err := h.svc.Test(h.ctx, ""); err != nil {
		t.Fatalf("Test(默认样例): %v", err)
	}
	if h.judge.text != want {
		t.Fatalf("空样例发的应当是默认样例，实际 %q", h.judge.text)
	}

	// **临时覆盖，不落库**：样例不是配置，跑完读回来还是默认值。
	again, err := h.svc.PreviewProbe(h.ctx, "")
	if err != nil {
		t.Fatalf("PreviewProbe: %v", err)
	}
	if again.UserText != want {
		t.Fatalf("样例被写进库了：读回 %q", again.UserText)
	}
}

// 预览的字段值（model / max_output_tokens / strict / tools）也要照配置给：前端要把整份请求摊开，
// 光给两段文本等于只说了一半 —— 而「参数与 schema 与真调用不同源」正是这个仓库栽过的坑。
func TestPreviewCarriesCallParameters(t *testing.T) {
	h := newHarness(t)
	if _, err := h.pool.Exec(h.ctx,
		"UPDATE ai_config SET model = 'probe-model', max_output_tokens = 777, strict_mode = true WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	pv, err := h.svc.PreviewProbe(h.ctx, "")
	if err != nil {
		t.Fatalf("PreviewProbe: %v", err)
	}
	if pv.Model != "probe-model" || pv.MaxOutputTokens != 777 || !pv.StrictMode {
		t.Fatalf("参数没跟着配置走: model=%q max=%d strict=%v", pv.Model, pv.MaxOutputTokens, pv.StrictMode)
	}
	if pv.ToolName != "submit_review" {
		t.Fatalf("tool_name=%q，真调用用的就是 submit_review（platform/ai 的 FunctionDefinitionParam）", pv.ToolName)
	}
	if len(pv.Categories) != len(ai.Categories) {
		t.Fatalf("categories 值域该照 ai.Categories 给：得到 %v", pv.Categories)
	}
}

// ── HTTP 层：端点真的挂上了，而且**空 body 也照样能用**（D33① 的接线判据）─────────────
//
// 为什么这条必须在 HTTP 层：上面那几条走的是 service，绕过路由与绑定 ——
// 而「端点在不在」正是最容易漏的一环（挂路由时依赖没接对、或绑定把空 body 判成 400）。
// 这条用例自己起一台 gin（注册法与 app/http.go 那行逐字一致），因此它同时钉住三件事：
// 路由存在、权限点生效、JSON 字段名就是前端要读的那些。

// newTestEngine 按 app 层的挂法注册（aireview.NewHandler(...).Register(v1, requireLogin, perm)）。
func newTestEngine(h *harness) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v1 := r.Group("/api/v1")
	// 用例里的「登录」就是带一个 X-Test-Actor 头：拿不到它就是 401（handler.require 的判据）。
	actor := func(c *gin.Context) (*authz.Actor, bool) {
		if c.GetHeader("X-Test-Actor") == "" {
			return nil, false
		}
		return &authz.Actor{UserID: h.authorID, Status: "active", Activated: true}, true
	}
	// 权限中间件收成与 app 层同一个签名：本用例把「有 site.setting」表达成 X-Test-Perm 头。
	// **401 / 403 的分界照 auth/middleware.go 的 requirePerm**：没有身份 → 401，有身份缺权限 → 403。
	perm := func(want ...string) gin.HandlerFunc {
		return func(c *gin.Context) {
			if c.GetHeader("X-Test-Actor") == "" {
				c.AbortWithStatus(http.StatusUnauthorized)
				return
			}
			if c.GetHeader("X-Test-Perm") != want[0] {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			c.Next()
		}
	}
	requireLogin := func() gin.HandlerFunc {
		return func(c *gin.Context) { c.Next() } // 401 由 require 自己判（handler.go）
	}
	aireview.NewHandler(h.svc, actor).Register(v1, requireLogin, perm)
	return r
}

// postJSON 发一条 JSON 请求，回状态码与解开的包络。
func postJSON(t *testing.T, r *gin.Engine, path, body string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
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

func TestPayloadEndpointIsWiredAndReadsTheRealTopic(t *testing.T) {
	h := newHarness(t)
	body := "正文第一行。" + nl2 + "![截图](/img/" + hash64("d") + ")" + nl2 + "最后一行。"
	id := h.topic("端点用例的帖子", body, nil, "pending")
	h.withImage(id, hash64("e"))
	r := newTestEngine(h)
	auth := map[string]string{"X-Test-Actor": "1", "X-Test-Perm": "site.setting"}
	payloadBody := "{\"topic_id\":" + fmt.Sprintf("%d", id) + "}"

	// ① 没登录 → 401（不是 500）
	if code, _ := postJSON(t, r, "/api/v1/admin/ai/payload", payloadBody, nil); code != http.StatusUnauthorized {
		t.Fatalf("没登录该 401，实际 %d", code)
	}
	// ② 登录但缺权限点 → 403（权限点沿用 site.setting，不新造）
	if code, _ := postJSON(t, r, "/api/v1/admin/ai/payload", payloadBody, map[string]string{"X-Test-Actor": "1"}); code != http.StatusForbidden {
		t.Fatalf("缺 site.setting 该 403，实际 %d", code)
	}

	// ③ 真读一条帖：字段名就是前端要读的那些，正文逐字进来
	code, out := postJSON(t, r, "/api/v1/admin/ai/payload", payloadBody, auth)
	if code != http.StatusOK {
		t.Fatalf("payload: %d %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil {
		t.Fatalf("回执没有 data 包络: %v", out)
	}
	if data["source"] != "topic" || data["title"] != "端点用例的帖子" {
		t.Fatalf("source/title 不对: %v", data)
	}
	if got, _ := data["user_body"].(string); got != "正文："+nl+body {
		t.Fatalf("user_body 不是 1 楼正文原文: 得到 %q 想要 %q", got, "正文："+nl+body)
	}
	if data["has_image_markdown"] != true || data["image_attachment_count"] != float64(1) {
		t.Fatalf("图片两个数不对: has=%v count=%v", data["has_image_markdown"], data["image_attachment_count"])
	}
	if data["tool_name"] != "submit_review" {
		t.Fatalf("tool_name=%v", data["tool_name"])
	}
	// ④ 主题不存在 → 404，不是 500
	if code, _ := postJSON(t, r, "/api/v1/admin/ai/payload", "{\"topic_id\":99999999}", auth); code != http.StatusNotFound {
		t.Fatalf("不存在的主题该 404，实际 %d", code)
	}

	// ⑤ **空 body** 走样例那一路（只想看样例、或老前端不发 body 都用这条）
	code3, out3 := postJSON(t, r, "/api/v1/admin/ai/payload", "", auth)
	if code3 != http.StatusOK {
		t.Fatalf("空 body 该走 probe 那一路，实际 %d %v", code3, out3)
	}
	d3, _ := out3["data"].(map[string]any)
	if d3["source"] != "probe" || d3["user_text"] != aireview.DefaultProbeSample {
		t.Fatalf("空 body 的 probe 回执不对: %v", d3)
	}
}

func TestTestEndpointAcceptsProbeOverrideAndEmptyBody(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	r := newTestEngine(h)
	auth := map[string]string{"X-Test-Actor": "1", "X-Test-Perm": "site.setting"}

	// ① 编辑过的样例：真发出去的就是它（D33③ 的判据：改得动，而且改了真的生效）
	custom := "标题：编辑过的样例" + "\\n\\n" + "正文：临时内容。"
	if code, out := postJSON(t, r, "/api/v1/admin/ai/test", "{\"probe\":"+mustJSON(t, custom)+"}", auth); code != http.StatusOK {
		t.Fatalf("test(自定义样例): %d %v", code, out)
	}
	if h.judge.text != custom {
		t.Fatalf("连通测试发的是 %q，想要我编辑过的 %q", h.judge.text, custom)
	}

	// ② 空 body（老前端就是这么调的）：不 400，发默认样例
	if code, out := postJSON(t, r, "/api/v1/admin/ai/test", "", auth); code != http.StatusOK {
		t.Fatalf("test(空 body): %d %v", code, out)
	}
	if h.judge.text != aireview.DefaultProbeSample {
		t.Fatalf("空 body 该发默认样例，实际 %q", h.judge.text)
	}
}

// nl / nl2 是换行常量：用字符串字面量写在表达式里会被 gofmt 与转义层来回折腾，
// 而这两段文本**逐字**要与 payload 里的换行相同（差一个都会红）。
const (
	nl  = "\n"
	nl2 = "\n\n"
)

// mustJSON 把一段文本编成 JSON 字符串字面量（样例里有换行，不能手拼）。
func mustJSON(t *testing.T, s string) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
