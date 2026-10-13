package auth

// 中间件与 handler 的测试：真路由（gin）+ 真库，断言的是**状态码与错误码**。
// 这里覆盖的是拍板 §9.12 的写闸门与设计 §6.4 的 401/403 分界——它们只在中间件里实现一次。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/httpx"
)

// newRouter 起一个最小 app：LoadPrincipal + 三个中间件各挂一条测试路由。
func (f *fixture) newRouter() *gin.Engine {
	f.t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v1 := r.Group("/api/v1", f.svc.LoadPrincipal())
	v1.GET("/me", func(c *gin.Context) {
		out, err := f.svc.Me(c.Request.Context(), actorFrom(c))
		if err != nil {
			// 与真正的 handler 同一条路径：只有 Fail 一处出错误响应
			httpx.Fail(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": out})
	})
	v1.POST("/write", f.svc.RequireActivated(), func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"data": "ok"}) })
	v1.POST("/admin", f.svc.RequireLogin(), f.svc.Perm(authz.PermUserBan), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "ok"})
	})
	return r
}

// do 发一个请求并返回状态码与响应体。
func (f *fixture) do(r *gin.Engine, method, path, cookie string) *httptest.ResponseRecorder {
	f.t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: f.cfg.Site.CookieName, Value: cookie})
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func errCodeOfBody(t *testing.T, body []byte) string {
	t.Helper()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("响应不是约定的错误形状: %s", string(body))
	}
	return env.Error.Code
}

// 游客：GET /me 200 且 data 为 null（设计 §9.2），写接口 401 common.unauthorized。
func TestMiddlewareGuest(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	r := f.newRouter()

	w := f.do(r, http.MethodGet, "/api/v1/me", "")
	if w.Code != http.StatusOK {
		t.Fatalf("游客 GET /me = %d，想要 200（游客不是错误）", w.Code)
	}
	if body := w.Body.String(); !contains(body, `"data":null`) {
		t.Fatalf("游客的 data 应当是 null，得到 %s", body)
	}

	w = f.do(r, http.MethodPost, "/api/v1/write", "")
	if w.Code != http.StatusUnauthorized || errCodeOfBody(t, w.Body.Bytes()) != "common.unauthorized" {
		t.Fatalf("游客写操作 = %d %s，想要 401 common.unauthorized", w.Code, w.Body.String())
	}
}

// 拍板 §9.12：写闸门只有一条——未激活 → 403 auth.not_activated；读不受限。
func TestMiddlewareWriteGate(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUserRow("notyet", "passw0rd-1", "user", false)
	r := f.newRouter()
	cookie := f.login("notyet", "passw0rd-1")

	if w := f.do(r, http.MethodGet, "/api/v1/me", cookie); w.Code != http.StatusOK {
		t.Fatalf("未激活用户读 = %d，想要 200（能登录、能读）", w.Code)
	}
	w := f.do(r, http.MethodPost, "/api/v1/write", cookie)
	if w.Code != http.StatusForbidden || errCodeOfBody(t, w.Body.Bytes()) != "auth.not_activated" {
		t.Fatalf("未激活写操作 = %d %s，想要 403 auth.not_activated", w.Code, w.Body.String())
	}

	// 激活之后同一个 cookie 立刻能写。
	var pub string
	if err := f.pool.QueryRow(f.ctx, "SELECT public_id FROM users WHERE username = 'notyet'").Scan(&pub); err != nil {
		t.Fatal(err)
	}
	root := f.newSuperAdmin("root")
	if err := f.svc.ActivateUser(f.ctx, root, pub, "127.0.0.1"); err != nil {
		t.Fatalf("激活失败: %v", err)
	}
	if w := f.do(r, http.MethodPost, "/api/v1/write", cookie); w.Code != http.StatusOK {
		t.Fatalf("激活后写操作 = %d，想要 200", w.Code)
	}
}

// 设计 §6.4：没有 Principal → 401；有 Principal 但缺权限 → 403（只在 requirePerm 一处实现）。
func TestMiddlewarePermissionBoundary(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("plain", "passw0rd-1", "user")
	r := f.newRouter()

	if w := f.do(r, http.MethodPost, "/api/v1/admin", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("未登录 -> %d，想要 401", w.Code)
	}
	cookie := f.login("plain", "passw0rd-1")
	w := f.do(r, http.MethodPost, "/api/v1/admin", cookie)
	if w.Code != http.StatusForbidden || errCodeOfBody(t, w.Body.Bytes()) != "common.forbidden" {
		t.Fatalf("普通用户 -> %d %s，想要 403 common.forbidden", w.Code, w.Body.String())
	}

	// 超管短路：**权限集合里没有这个点**也必须放行（拍板 §9.8 第 1 条）。
	root := f.newSuperAdmin("root")
	if root.Perms.Has(authz.PermUserBan) {
		t.Fatal("夹具问题：超管的集合里本来就有 user.ban，测不出短路")
	}
	rootCookie := f.login("root", "passw0rd-1")
	if w := f.do(r, http.MethodPost, "/api/v1/admin", rootCookie); w.Code != http.StatusOK {
		t.Fatalf("超管 -> %d %s，想要 200（超管短路必须放在权限集合之前）", w.Code, w.Body.String())
	}
}

// 封号后旧 Cookie 的下一个请求就是 401（设计 §6.6：不等任何 TTL）。
func TestMiddlewareBannedCookieIsGuest(t *testing.T) {
	f := newFixture(t)
	f.seedRBAC()
	f.newUser("doomed", "passw0rd-1", "user")
	r := f.newRouter()
	cookie := f.login("doomed", "passw0rd-1")

	root := f.newSuperAdmin("root")
	var pub string
	if err := f.pool.QueryRow(f.ctx, "SELECT public_id FROM users WHERE username = 'doomed'").Scan(&pub); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.BanUser(f.ctx, root, BanInput{UserPublicID: pub, Action: "ban", IP: "127.0.0.1"}); err != nil {
		t.Fatal(err)
	}
	w := f.do(r, http.MethodPost, "/api/v1/write", cookie)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("封号后写操作 = %d，想要 401", w.Code)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
