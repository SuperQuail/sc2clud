package site_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/site"
)

// TestNonUUIDPathIDIsBadRequest 钉住路径参数闸（httpx.ValidPathIDs 挂在 site.Register 的组上）：
// 非 uuid 的 {id} 必须在进 service 之前被挡成 400。
//
// 本域 {id} 三条：POST /banners/{id}/dismiss、PATCH /admin/announcements/{id}、PATCH /admin/banners/{id}。
// 挂闸前这里是 404（DismissBanner 自己 idgen.ParsePublicID 后按「这个横幅不存在」处理）。
func TestNonUUIDPathIDIsBadRequest(t *testing.T) {
	h := newHarness(t)

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	mw := func(...string) gin.HandlerFunc { return noop }
	login := func() gin.HandlerFunc { return noop }
	actor := h.adminActor()
	site.NewHandler(h.svc, func(*gin.Context) (*authz.Actor, bool) { return actor, true }).
		Register(engine.Group("/api/v1"), login, mw)

	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/banners/not-a-uuid/dismiss", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的路径 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
