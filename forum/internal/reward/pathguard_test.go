package reward_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
	"forum/internal/reward"
)

// TestNonUUIDPathIDIsRejectedBeforeService 钉住路径参数闸（httpx.ValidPathIDs 挂在 reward.Register 的组上）：
// 非 uuid 的 {id} 必须在**进 service、也在过鉴权之前**就被挡成 400。
//
// 本域 {id} 两条：DELETE /rewards/{id}、POST /admin/rewards/{id}/verify。
//
// 为什么不像别的域那样「打真请求 + 断言 400」：reward 的 service 早就把非 uuid 翻成
// ErrInvalidInput + {id: 格式不正确}，与闸的 400 逐字节相同 —— 那种断言挂闸前就是绿的，证明不了闸存在。
// 这里改用两处可观测的差异：
//   - requireLogin 故意失败：挂闸前请求先吃 401，挂闸后格式先被判 → 400；
//   - handler 接 nil *Service：400 只可能来自闸，service 一次都没被碰。
func TestNonUUIDPathIDIsRejectedBeforeService(t *testing.T) {
	engine := gin.New()
	mw := func(...string) gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }
	limit := func(string, gin.HandlerFunc) gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }
	reject := func(...string) gin.HandlerFunc {
		return func(c *gin.Context) {
			httpx.Fail(c, apperr.ErrUnauthorized)
			c.Abort()
		}
	}

	me := &authz.Actor{UserID: 1, Status: "active"}
	reward.NewHandler(nil, func(*gin.Context) (*authz.Actor, bool) { return me, true }).
		Register(engine.Group("/api/v1"), reject, mw, limit)

	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/rewards/not-a-uuid", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的路径 id 必须在鉴权与 service 之前被挡成 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
