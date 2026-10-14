package report_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/report"
)

// TestNonUUIDPathIDIsBadRequest 钉住路径参数闸（httpx.ValidPathIDs 挂在 report.Register 的组上）：
// 非 uuid 的 {id} 必须在进 service 之前被挡成 400。
//
// 本域 {id} 一条：PATCH /admin/reports/{id}。挂闸前这里是 404（Handle 自己 idgen.ParsePublicID
// 后按「查不到」处理）。body 必须是能过 Bind 的合法体，否则绑定失败的 400 会把这条用例测糊。
func TestNonUUIDPathIDIsBadRequest(t *testing.T) {
	h := newHarness(t)

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	mw := func(...string) gin.HandlerFunc { return noop }
	login := func() gin.HandlerFunc { return noop }
	limit := func(string, gin.HandlerFunc) gin.HandlerFunc { return noop }
	admin := h.admin()
	report.NewHandler(h.svc, func(*gin.Context) (*authz.Actor, bool) { return admin, true }).
		Register(engine.Group("/api/v1"), login, mw, limit)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/reports/not-a-uuid",
		strings.NewReader(`{"state":"handled","note":"已处理"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的路径 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
