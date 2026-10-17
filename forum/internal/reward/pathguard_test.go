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

// TestNonUUIDPathIDNeedsIdentityFirst 钉住**中间件顺序**（拍板 08 · C9-3：先验身份再验路径 ID）。
//
// 本域 {id} 两条：DELETE /rewards/{id}、POST /admin/rewards/{id}/verify，两条都要登录。
//
// 这条用例**在 2026-10-14 改过口径**：它原来断言「非 uuid 在鉴权之前就被挡成 400」
// （闸挂在 rg.Group 上，跑在 requireLogin 之前）。C9-3 拍板后顺序反过来 ——
// 未登录的非 uuid 请求先吃 401，只有**身份过了**才轮到格式判定（那时才是 400，见下一条用例）。
// 同一个请求两个码，靠顺序差区分，所以这条断言是顺序的唯一守卫。
func TestNonUUIDPathIDNeedsIdentityFirst(t *testing.T) {
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
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("未登录的非 uuid 请求应当先吃 401（先验身份再验路径 ID），实际 %d：%s", w.Code, w.Body.String())
	}
}

// TestNonUUIDPathIDIsBadRequestOnceAuthed 是上一条的另一半：身份过了之后，格式判定必须给出 400。
//
// handler 接 nil *Service：400 只可能来自闸，service 一次都没被碰 ——
// reward 的 service 也把非 uuid 翻成 400，所以只断言状态码会变成「永远通过」的检查。
func TestNonUUIDPathIDIsBadRequestOnceAuthed(t *testing.T) {
	engine := gin.New()
	mw := func(...string) gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }
	limit := func(string, gin.HandlerFunc) gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }
	pass := func(...string) gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }

	me := &authz.Actor{UserID: 1, Status: "active"}
	reward.NewHandler(nil, func(*gin.Context) (*authz.Actor, bool) { return me, true }).
		Register(engine.Group("/api/v1"), pass, mw, limit)

	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/rewards/not-a-uuid", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("登录后的非 uuid 路径 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
