package forum

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// C9-3（拍板 08）：**先验身份，再验路径 ID**。
//
// 同一个请求（非 uuid 的 {id}）在两个身份下必须拿到两个不同的码：
//
//	· 未登录 → 401（身份都没过，轮不到格式判定）；
//	· 已登录 → 400（身份过了，格式判定接管；C9-1：语义统一成 400）。
//
// 这条用例的判据是**顺序**，所以两个断言缺一不可：只断言 400 会在旧顺序下绿，
// 只断言 401 会在「把闸整个删掉」时也绿（那样 service 会把非 uuid 翻成 404）。
// 它用的 requireLogin 是**真的会拒**的那个（与 app 层 RequireLogin 同语义），
// 所以「未登录」这一支不是靠假中间件让出来的。
func TestWritePathChecksIdentityBeforePathID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newHarness(t)
	author, _ := h.setupTopic(t)

	current := &authz.Actor{}
	// 身份注入 + 真的会拒的 requireLogin：与 app 层「LoadPrincipal 放 Actor、RequireLogin 判它」同形。
	requireLogin := func(c *gin.Context) {
		if current.UserID != 0 {
			c.Set(principalKey, current)
		}
		if v, ok := c.Get(principalKey); !ok || v.(*authz.Actor).UserID == 0 {
			httpx.Fail(c, apperr.ErrUnauthorized)
			c.Abort()
			return
		}
		c.Next()
	}
	api := NewHandler(h.svc, func(c *gin.Context) *authz.Actor {
		if v, ok := c.Get(principalKey); ok {
			return v.(*authz.Actor)
		}
		return nil
	})
	r := gin.New()
	api.Register(r.Group("/api/v1"), requireLogin, func(string) gin.HandlerFunc {
		return func(c *gin.Context) { c.Next() }
	})

	do := func(method, path, body string) int {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code
	}

	// ① 未登录 + 非 uuid 的写请求 → 401（**旧顺序下这里是 400**）
	current = &authz.Actor{}
	if code := do(http.MethodPatch, "/api/v1/topics/not-a-uuid", `{"title":"x"}`); code != http.StatusUnauthorized {
		t.Fatalf("未登录的非 uuid 请求应当 401（先验身份再验路径 ID），实际 %d", code)
	}
	if code := do(http.MethodDelete, "/api/v1/posts/not-a-uuid", ""); code != http.StatusUnauthorized {
		t.Fatalf("未登录的非 uuid 请求应当 401，实际 %d", code)
	}

	// ② 已登录 + 同一个非 uuid 请求 → 400（身份过了，路径闸接管）
	current = author
	if code := do(http.MethodPatch, "/api/v1/topics/not-a-uuid", `{"title":"x"}`); code != http.StatusBadRequest {
		t.Fatalf("登录后的非 uuid 路径参数应当 400，实际 %d", code)
	}

	// ③ 公开读没有身份可验：非 uuid 仍然是 400（C9-1 的语义统一，与身份无关）
	current = &authz.Actor{}
	if code := do(http.MethodGet, "/api/v1/topics/not-a-uuid", ""); code != http.StatusBadRequest {
		t.Fatalf("公开读的非 uuid 路径参数应当 400，实际 %d", code)
	}
}
