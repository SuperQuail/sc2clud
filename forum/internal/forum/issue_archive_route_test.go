package forum

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// 0062 管理端三条路由的端到端：绑定 → 取 actor → service → httpx 包络。
//
// 钉的是**路由挂没挂、包络对不对、PathGuard 在不在**（service 那一半在 issue_archive_test.go）。
// 假中间件与 handler_test.go 同一套：身份放 gin 容器；requireLogin 恒放行，
// 权限点由 service 判 —— 所以身份必须自带 post.review。
func TestIssueArchiveRoutesEndToEnd(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newHarness(t)
	author, topic := h.setupTopic(t)
	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}
	reporter, _ := h.author("reporter", 3, true, authz.PermTopicCreate)
	iss := h.mustIssue(reporter, topic.ID, CreateIssueInput{Kind: "bug", Title: "卡关", BodyMD: "第二波卡"})
	admin, _ := h.author("admin", 4, false, authz.PermPostReview)
	admin.Perms = authz.NewSet(authz.PermPostReview)
	guest := &authz.Actor{}

	current := guest
	fakePrincipal := func(c *gin.Context) {
			if current.UserID != 0 {
			c.Set(principalKey, current)
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
	r := gin.New()
	// 身份中间件挂**引擎上**而不是路由组上：本域的 public 读组是 `rg.Group("", ValidPathIDs...)`，
	// 而 gin 的 Group 只继承**它自己的**父组 handlers —— 挂在路由组上的中间件到不了读组
	// （app 层是 v1.Use(LoadPrincipal) 挂在引擎那一层，形状不同但效果一致）。
	r.Use(fakePrincipal)
	api.Register(r.Group("/api/v1"), fakePrincipal, func(string) gin.HandlerFunc {
		return func(c *gin.Context) { c.Next() }
	})

	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	// okBody 是 pin/lock 那套回执的形状：200 + {"ok":true}
	const okBody = "\"ok\":true"

	// ① 未登录 → 401（假 requireLogin 放行，于是 401 由 service 的第一道闸给出）
	current = guest
	if w := do(http.MethodGet, "/api/v1/admin/issues", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("未登录看管理端列表应 401，实际 %d: %s", w.Code, w.Body.String())
	}

	// ② 列表：包络 {data, next_cursor, counts}
	current = admin
	w := do(http.MethodGet, "/api/v1/admin/issues", "")
	if w.Code != http.StatusOK {
		t.Fatalf("管理端列表应 200，实际 %d: %s", w.Code, w.Body.String())
	}
	var page struct {
		Data       []map[string]any `json:"data"`
		NextCursor any              `json:"next_cursor"`
		Counts     map[string]int   `json:"counts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatalf("列表响应不是 JSON: %v —— %s", err, w.Body.String())
	}
	if len(page.Data) != 1 || page.NextCursor != nil {
		t.Fatalf("列表响应不对: %s", w.Body.String())
	}
	if page.Counts["active"] != 1 || page.Counts["archived"] != 0 || page.Counts["all"] != 1 {
		t.Fatalf("归档前的 counts 不对: %v", page.Counts)
	}
	if _, ok := page.Data[0]["archive_reason"]; !ok {
		t.Fatalf("管理端 DTO 该有 archive_reason 字段: %s", w.Body.String())
	}

	// ③ 归档：200 {"ok":true}（与 pin/lock 同形）
	if w := do(http.MethodPost, "/api/v1/admin/issues/"+iss.ID+"/archive", "{\"reason\":\"广告引流\"}"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), okBody) {
		t.Fatalf("归档应 200 {ok:true}，实际 %d: %s", w.Code, w.Body.String())
	}
	// 归档之后：缺省列表看不到它，archived=1 看得到（且 counts 随之变化）
	if w := do(http.MethodGet, "/api/v1/admin/issues", ""); strings.Contains(w.Body.String(), iss.ID) {
		t.Fatalf("缺省列表不该含已归档的: %s", w.Body.String())
	}
	w = do(http.MethodGet, "/api/v1/admin/issues?archived=1", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), iss.ID) {
		t.Fatalf("archived=1 该看得到它，实际 %d: %s", w.Code, w.Body.String())
	}
	var archivedPage struct {
		Counts map[string]int `json:"counts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &archivedPage); err != nil {
		t.Fatal(err)
	}
	// counts 不跟着 archived 筛选变：三档一直看得见（切到已归档那一档时「未归档 N」不该变 0）
	if archivedPage.Counts["active"] != 0 || archivedPage.Counts["archived"] != 1 || archivedPage.Counts["all"] != 1 {
		t.Fatalf("归档后的 counts 不对: %v", archivedPage.Counts)
	}
	// 非法 archived 值 → 400（不静默当默认）
	if w := do(http.MethodGet, "/api/v1/admin/issues?archived=yes", ""); w.Code != http.StatusBadRequest {
		t.Fatalf("archived=yes 应 400，实际 %d: %s", w.Code, w.Body.String())
	}
	// 非 uuid 的 {id}：PathGuard 挡在 service 之前 → 400（不是 22P02 → 500）
	if w := do(http.MethodPost, "/api/v1/admin/issues/not-a-uuid/archive", "{}"); w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 应 400，实际 %d: %s", w.Code, w.Body.String())
	}

	// ④ 已归档的详情：游客 404（与不存在同形），持 post.review 的人看得见
	current = guest
	if w := do(http.MethodGet, "/api/v1/issues/"+iss.ID, ""); w.Code != http.StatusNotFound {
		t.Fatalf("已归档的详情对游客应 404，实际 %d: %s", w.Code, w.Body.String())
	}
	current = admin
	if w := do(http.MethodGet, "/api/v1/issues/"+iss.ID, ""); w.Code != http.StatusOK {
		t.Fatalf("管理员该看得见已归档详情，实际 %d: %s", w.Code, w.Body.String())
	}

	// ⑤ 恢复：200 {ok:true}，之后公共详情又对游客可读
	if w := do(http.MethodPost, "/api/v1/admin/issues/"+iss.ID+"/restore", ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), okBody) {
		t.Fatalf("恢复应 200 {ok:true}，实际 %d: %s", w.Code, w.Body.String())
	}
	current = guest
	if w := do(http.MethodGet, "/api/v1/issues/"+iss.ID, ""); w.Code != http.StatusOK {
		t.Fatalf("恢复之后游客该读得到详情，实际 %d: %s", w.Code, w.Body.String())
	}
}
