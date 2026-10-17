package notify

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// C9-2（拍板 08）：本域的 `{id}` 也要进路径闸，非 uuid 一律 400（不是 500）。
//
// 判据是「**service 没被碰到**」：handler 接一个零值 Handler（svc == nil），
// 非 uuid 若放过去就会在 service 里 panic 或报 22P02 —— 两种都不是 400。
// 顺带钉住顺序：requireLogin 排在闸之前（未登录先 401，见 C9-3）。
func TestNonUUIDNotificationIDIsBadRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)
	eng := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	deny := func(c *gin.Context) { c.AbortWithStatus(http.StatusUnauthorized) }

	// ① 登录过：非 uuid → 400（闸在 handler 之前）
	h := NewHandler(nil, func(*gin.Context) (*authz.Actor, bool) { return &authz.Actor{UserID: 1}, true })
	h.Register(eng.Group("/api/v1"), noop)
	w := httptest.NewRecorder()
	eng.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/notifications/not-a-uuid", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的通知 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}

	// ② 未登录：同一条请求先吃 401（先验身份再验路径 ID）
	eng2 := gin.New()
	NewHandler(nil, func(*gin.Context) (*authz.Actor, bool) { return nil, false }).Register(eng2.Group("/api/v1"), deny)
	w2 := httptest.NewRecorder()
	eng2.ServeHTTP(w2, httptest.NewRequest(http.MethodDelete, "/api/v1/notifications/not-a-uuid", nil))
	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("未登录的非 uuid 请求应当 401，实际 %d", w2.Code)
	}
}
