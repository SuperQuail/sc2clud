package forum

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// 路由层的一条端到端：绑定 → 取 actor → service → httpx.OK/Created/Fail。
// requireLogin 与 perm 由 app 层注入，本域不 import auth 域；测试里用「从容器取」的假中间件替代，
// 这条路径与 app 层真实注入的形状一致（LoadPrincipal 也是把 Actor 放进 gin 容器）。
func TestRoutesEndToEnd(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newHarness(t)
	author, topic := h.setupTopic(t)

	// current 是本次请求的身份：假中间件把它放进容器，与 app 层同一条路径。
	current := &authz.Actor{}
	fakePrincipal := func(c *gin.Context) {
		if current.UserID != 0 {
			c.Set(principalKey, current)
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
	// 公开读 + 写路由都挂上：写路由的 requireLogin 就是这套假中间件。
	api.Register(r.Group("/api/v1"), fakePrincipal, func(string) gin.HandlerFunc {
		return func(c *gin.Context) { c.Next() }
	})

	do := func(method, path, body string) *httptest.ResponseRecorder {
		var rdr *strings.Reader
		if body == "" {
			rdr = strings.NewReader("")
		} else {
			rdr = strings.NewReader(body)
		}
		req := httptest.NewRequest(method, path, rdr)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	// 游客列表：一条过审主题，next_cursor 是 null。
	w := do(http.MethodGet, "/api/v1/topics", "")
	if w.Code != http.StatusOK {
		t.Fatalf("游客列表应 200，实际 %d: %s", w.Code, w.Body.String())
	}
	var list struct {
		Data       []map[string]any `json:"data"`
		NextCursor any              `json:"next_cursor"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Data) != 1 || list.NextCursor != nil {
		t.Fatalf("列表响应不对: %s", w.Body.String())
	}

	// 详情：content_html 与 viewer 都在。
	w = do(http.MethodGet, "/api/v1/topics/"+topic.ID, "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "content_html") ||
		!strings.Contains(w.Body.String(), "viewer") {
		t.Fatalf("详情响应不对（%d）: %s", w.Code, w.Body.String())
	}

	// 未登录发帖：handler 取不到 actor → service 第一道闸 → 401。
	current = &authz.Actor{}
	w = do(http.MethodPost, "/api/v1/topics", `{"board":"general","title":"x","content_md":"y"}`)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("未登录发帖应 401，实际 %d: %s", w.Code, w.Body.String())
	}

	// 登录发帖：201 + 详情体。
	current = author
	w = do(http.MethodPost, "/api/v1/topics", `{"board":"general","title":"第二帖","content_md":"正文"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("登录发帖应 201，实际 %d: %s", w.Code, w.Body.String())
	}

	// 未知分区：404 board.not_found，且响应体里带 code。
	w = do(http.MethodGet, "/api/v1/boards/nope", "")
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "board.not_found") {
		t.Fatalf("未知分区应 404 board.not_found，实际 %d: %s", w.Code, w.Body.String())
	}

	// 损坏的游标：400 common.invalid_input。
	w = do(http.MethodGet, "/api/v1/topics?cursor=abc", "")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "common.invalid_input") {
		t.Fatalf("损坏游标应 400，实际 %d: %s", w.Code, w.Body.String())
	}

	// 转链端点：资源帖的一条源，302 且 Location 是作者登记的那个 URL。
	if err := h.svc.UpdateTopic(h.ctx, author, topic.ID, UpdateTopicInput{Kind: ptrStr("resource")}); err != nil {
		t.Fatal(err)
	}
	src, err := h.svc.SaveSource(h.ctx, author, topic.ID, SourceInput{Provider: "baidu", URL: "https://pan.baidu.com/s/abc"})
	if err != nil {
		t.Fatal(err)
	}
	w = do(http.MethodGet, "/api/v1/topics/"+topic.ID+"/sources/"+src.ID+"/go", "")
	if w.Code != http.StatusFound {
		t.Fatalf("转链应 302，实际 %d: %s", w.Code, w.Body.String())
	}
	if loc := w.Header().Get("Location"); loc != "https://pan.baidu.com/s/abc" {
		t.Fatalf("Location 不对: %q", loc)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("转链必须 no-store，实际 %q", cc)
	}

	// 主题不存在时 404（不暴露它是否存在）。
	w = do(http.MethodGet, "/api/v1/topics/00000000-0000-7000-8000-000000000000/posts", "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("未知主题应 404，实际 %d", w.Code)
	}
}

// principalKey 与 app 层的约定一致：身份放在 gin 容器里，handler 用 ActorFunc 取出来。
const principalKey = "forum.principal"
