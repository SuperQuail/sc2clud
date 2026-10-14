package media_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/media"
)

// TestNonUUIDPathIDIsBadRequest 钉住路径参数闸（httpx.ValidPathIDs 挂在 media.Register 的组上）：
// 非 uuid 的 {id} 必须在进 service 之前被挡成 400。
//
// 挂闸前这里是 500：DELETE /me/payment-channels/{id} 把 "not-a-uuid" 直接送进
// `DELETE FROM payment_channels WHERE public_id = $1`，PostgreSQL 22P02 冒到 HTTP 就是 common.internal。
func TestNonUUIDPathIDIsBadRequest(t *testing.T) {
	h := newHarness(t)
	alice := h.newUser("alice")

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	mw := func(...string) gin.HandlerFunc { return noop }
	hnd := media.NewHandler(h.svc, func(*gin.Context) (*authz.Actor, bool) { return h.actor(alice), true })
	hnd.Register(engine.Group("/api/v1"), mw, mw, nil)

	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/me/payment-channels/not-a-uuid", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的路径 id 必须是 400（挂闸前是 500），实际 %d：%s", w.Code, w.Body.String())
	}
}
