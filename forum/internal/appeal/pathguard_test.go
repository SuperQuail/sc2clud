package appeal

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// C9-2（拍板 08）：作者对审核结果申诉的 `{id}` 是主题的 public_id，非 uuid 一律 400。
//
// 判据同上一条：路径闸排在 requireLogin / perm **之后**、handler **之前**。
// 这里给一个恒真的 perm 与 requireLogin，让请求走到闸；非 uuid 若放过去就会进 service
// 并在 SQL 的 uuid 比较上报 22P02 → 500。
func TestNonUUIDTopicIDIsBadRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)
	eng := gin.New()
	pass := func() gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }
	perm := func(...string) gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }
	limitIP := func(_ string, mw ...gin.HandlerFunc) gin.HandlerFunc {
		return func(c *gin.Context) {
			for _, m := range mw {
				m(c)
			}
		}
	}
	// f 是「给这次请求造一个 Handler」的工厂；本用例只验路由与闸，service 给 nil。
	f := func(fn func(*Handler) gin.HandlerFunc) gin.HandlerFunc { return fn(&Handler{}) }

	RegisterRoutes(eng.Group("/api/v1"), f, pass, perm, limitIP)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/topics/not-a-uuid/review/appeal", nil)
	eng.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的主题 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
