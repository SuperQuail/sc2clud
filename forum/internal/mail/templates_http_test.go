package mail_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/mail"
)

// HTTP 层钉的是**前端读的那些东西**：状态码、error.fields 的字段名（对上编辑框）、
// 以及「拒收之后库里没有半截状态」。service 层用例断言不到字段名 —— 那正是本仓库最高频的事故。
func TestMailTemplateHTTPContract(t *testing.T) {
	h := newHarness(t)
	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	mw := func(...string) gin.HandlerFunc { return noop }
	login := func() gin.HandlerFunc { return noop }
	mail.NewHandler(h.svc, func(*gin.Context) (*authz.Actor, bool) {
		return h.tplActor(), true
	}).Register(engine.Group("/api/v1"), login, mw)

	// ① 语法错 → 400，错误原话落在 html_body 字段上、带行位（不许包装成 500）。
	// body 里故意放 \n（JSON 转义）把语法错挤到第 2 行：行位断言才有意义。
	badBody := "{\"subject\":\"s\",\"html_body\":\"&nbsp;\\n<p>{{.Code}</p>\",\"text_body\":\"t\"}"

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/mail-templates/verify_email", strings.NewReader(badBody))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("编译不过必须 400，实际 %d：%s", w.Code, w.Body.String())
	}
	var bad struct {
		Error struct {
			Code   string            `json:"code"`
			Fields map[string]string `json:"fields"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &bad); err != nil {
		t.Fatal(err)
	}
	if bad.Error.Code == "" || !strings.Contains(bad.Error.Fields["html_body"], "verify_email:html:2") {
		t.Fatalf("错误必须带字段名与行位: %+v", bad.Error)
	}

	// ② 拒收之后：库里没有半截行（列表仍是 custom=false 的四行内置）
	w2 := httptest.NewRecorder()
	engine.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "/api/v1/admin/mail-templates", nil))
	if w2.Code != http.StatusOK {
		t.Fatalf("列表必须 200，实际 %d：%s", w2.Code, w2.Body.String())
	}
	var list struct {
		Data []struct {
			Kind   string `json:"kind"`
			Custom bool   `json:"custom"`
			HTML   string `json:"html_body"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &list); err != nil {
		t.Fatalf("回执形状不对: %v：%s", err, w2.Body.String())
	}
	if len(list.Data) != 4 {
		t.Fatalf("四行，实际 %d：%s", len(list.Data), w2.Body.String())
	}
	for _, v := range list.Data {
		if v.Custom || v.HTML == "" {
			t.Fatalf("拒收之后 %s 不该变 custom、内置源也不该空：%+v", v.Kind, v)
		}
	}

	// ③ 预览端点：样本昵称带 <script>，HTML 预览是转义后的；纯文本并列保留原文
	prevBody := `{"kind":"verify_email","html_body":"<p>预览 {{.Code}} {{.Nickname}}</p>"}`
	w3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodPost, "/api/v1/admin/mail-templates/preview", strings.NewReader(prevBody))
	req3.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(w3, req3)
	if w3.Code != http.StatusOK {
		t.Fatalf("预览必须 200，实际 %d：%s", w3.Code, w3.Body.String())
	}
	var prev struct {
		Data struct {
			Subject string `json:"subject"`
			Text    string `json:"text"`
			HTML    string `json:"html"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w3.Body.Bytes(), &prev); err != nil {
		t.Fatalf("预览回执形状不对: %v：%s", err, w3.Body.String())
	}
	if !strings.Contains(prev.Data.HTML, "&lt;script&gt;alert(1)&lt;/script&gt;") || strings.Contains(prev.Data.HTML, "<script>alert(1)</script>") {
		t.Fatalf("HTML 预览没转义: %s", prev.Data.HTML)
	}
	if !strings.Contains(prev.Data.Text, "<script>alert(1)</script>") || prev.Data.Subject != "邮箱验证码" {
		t.Fatalf("回落语义不对: %+v", prev.Data)
	}
}

// 缺 site.setting 的登录者：401/403 由 requirePerm 兜住（路由的 perm 中间件在测试里 noop）。
func TestMailTemplateHTTPForbidden(t *testing.T) {
	h := newHarness(t)
	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	mail.NewHandler(h.svc, func(*gin.Context) (*authz.Actor, bool) {
		return &authz.Actor{UserID: h.userID, Perms: authz.NewSet(authz.PermMailManage), Status: "active"}, true
	}).Register(engine.Group("/api/v1"), func() gin.HandlerFunc { return noop }, func(...string) gin.HandlerFunc { return noop })
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/mail-templates/notice",
		strings.NewReader(`{"subject":"s","html_body":"<p>x</p>","text_body":"t"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("缺 site.setting 必须 403，实际 %d：%s", w.Code, w.Body.String())
	}
}
