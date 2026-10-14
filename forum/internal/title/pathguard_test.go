package title

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// TestNonUUIDPathIDIsBadRequest 钉住路径参数闸（httpx.ValidPathIDs 挂在 title.Register 的组上）：
// 非 uuid 的 {id} 必须在进 service 之前被挡成 400。
//
// 本域 {id} 两条：PATCH /admin/titles/{id}、POST|DELETE /admin/users/{id}/titles/{titleId}。
// 闸只点名 "id"：:handle 是用户名，:titleId 由 service 的 checkPublicID 兜（语义是「找不到」）。
// 挂闸前这里是 404（UpdateTitle 的 checkPublicID 把格式错当「找不到」）。
func TestNonUUIDPathIDIsBadRequest(t *testing.T) {
	f := newFixture(t)

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	perm := func(_ ...string) gin.HandlerFunc { return noop }
	h := NewHandler(f.svc, nil, func(*gin.Context) (*authz.Actor, bool) { return f.admin(), true })
	h.Register(engine.Group("/api/v1"), noop, perm)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/titles/not-a-uuid", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的路径 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
