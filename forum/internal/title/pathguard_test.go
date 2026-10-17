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
// 本域三个路径参数都要进闸（拍板 08 · C9-1：同类 {id} 语义统一成 400）：
// PATCH /admin/titles/{id}、POST|DELETE /admin/users/{id}/titles/{titleId}。
// :handle 是用户名，不在闸里。
//
// 挂闸前 {titleId} 那条走的是 service 的 checkPublicID（把格式错当「找不到」，404）——
// 所以下面第二条在旧行为下是 404 而不是 400，这条断言不是「永远通过」的。
func TestNonUUIDPathIDIsBadRequest(t *testing.T) {
	f := newFixture(t)

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	perm := func(_ ...string) gin.HandlerFunc { return noop }
	h := NewHandler(f.svc, nil, func(*gin.Context) (*authz.Actor, bool) { return f.admin(), true })
	h.Register(engine.Group("/api/v1"), noop, perm)

	cases := []struct {
		name, method, path, body string
	}{
		{"{id}", http.MethodPatch, "/api/v1/admin/titles/not-a-uuid", `{"name":"x"}`},
		{"{titleId}", http.MethodPost, "/api/v1/admin/users/11111111-1111-7111-8111-111111111111/titles/not-a-uuid", ""},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s：非 uuid 的路径 id 必须是 400，实际 %d：%s", tc.name, w.Code, w.Body.String())
		}
	}
}
