package message

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// TestNonUUIDPathIDIsBadRequest 钉住路径参数闸（httpx.ValidPathIDs 挂在 message.Register 的组上）：
// 非 uuid 的 {id} 必须在进 service 之前被挡成 400。
//
// 本域只有一条 {id} 路径 DELETE /messages/{id}（其余是 :handle，不是 ID）。
// 挂闸前这里是 404（service 自己 idgen.ParsePublicID 后按「查不到」处理）。
func TestNonUUIDPathIDIsBadRequest(t *testing.T) {
	f := newFixture(t, "alice")

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	NewHandler(f.svc, func(*gin.Context) (*authz.Actor, bool) { return f.actor("alice"), true }).
		Register(engine.Group("/api/v1"), noop)

	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/messages/not-a-uuid", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的路径 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
