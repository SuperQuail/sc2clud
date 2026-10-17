package release_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/release"
)

// TestNonUUIDPathIDIsBadRequest 钉住路径参数闸（httpx.ValidPathIDs 挂在 release.Register 的组上）：
// 非 uuid 的 {id} 必须在进 service 之前被挡成 400。
//
// 挂闸前这里是 404：resolveAsset 自己 uuid.Parse 一把，格式不对按「没有这个产物」处理。
// 两类都被闸收口成同一种「路径 id 格式不对」，不再靠每个域各自记得 parse。
func TestNonUUIDPathIDIsBadRequest(t *testing.T) {
	h := newHarness(t)

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	mw := func(...string) gin.HandlerFunc { return noop }
	release.NewHandler(h.svc, func(*gin.Context) (*authz.Actor, bool) { return h.adminActor(), true }).
		Register(engine.Group("/api/v1"), mw, mw)

	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/launcher/assets/not-a-uuid/go", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的路径 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
