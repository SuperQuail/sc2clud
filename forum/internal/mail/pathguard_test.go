package mail_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/mail"
)

// TestNonUUIDPathIDIsBadRequest 钉住路径参数闸（httpx.ValidPathIDs 挂在 mail.Register 的组上）：
// 非 uuid 的 {id} 必须在进 service 之前被挡成 400。
//
// 本域 {id} 三条都在 /admin 下：PATCH /admin/mail/accounts/{id}、
// DELETE /admin/mail/accounts/{id}、POST /admin/mail/accounts/{id}/test。
// 挂闸前这里是 404（accounts.go 自己 idgen.ParsePublicID 后按「找不到」处理）。
func TestNonUUIDPathIDIsBadRequest(t *testing.T) {
	h := newHarness(t)

	engine := gin.New()
	noop := func(c *gin.Context) { c.Next() }
	mw := func(...string) gin.HandlerFunc { return noop }
	login := func() gin.HandlerFunc { return noop }
	mail.NewHandler(h.svc, func(*gin.Context) (*authz.Actor, bool) {
		return &authz.Actor{UserID: h.userID, Perms: authz.NewSet(authz.PermMailManage), Status: "active"}, true
	}).Register(engine.Group("/api/v1"), login, mw)

	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/v1/admin/mail/accounts/not-a-uuid", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非 uuid 的路径 id 必须是 400，实际 %d：%s", w.Code, w.Body.String())
	}
}
