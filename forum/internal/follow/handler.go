package follow

import (
	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// ActorFromGin 由 app 注入 auth.FromGin（与其它域逐字相同的形状，接线时直接赋值）。
type ActorFromGin func(c *gin.Context) (*authz.Actor, bool)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx 写响应（拍板 §5.3）。
type Handler struct {
	svc     *Service
	actorOf ActorFromGin
}

func NewHandler(svc *Service, actorOf ActorFromGin) *Handler {
	return &Handler{svc: svc, actorOf: actorOf}
}

// Register 挂本域的九条路由。
//
// 分组不是按对象分的，是**按要不要登录**分的（这是本域唯一的分界）：
//   - 关注数 / 关注者列表是**公开读**（分区页那格「成员」游客也要看得到）；
//   - 关注 / 取关 / 「我关注的」是本人语义，必须登录。
//
// 两条列表的路径都在各自域的已有前缀下（/boards/{slug}/… 与 /users/{handle}/…）：
// 关注是**这两个资源的动作**，挂到别处（/follows?target=…）只会让前端多一层拼装。
// 本域没有 {id} 路径参数（:slug / :handle 都不是 uuid），所以不需要 httpx.ValidPathIDs。
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc) {
	// 公开：谁关注了它 / 谁关注了它（游客可读）
	rg.GET("/boards/:slug/followers", h.boardFollowers)
	rg.GET("/users/:handle/followers", h.userFollowers)

	g := rg.Group("", requireLogin)
	g.GET("/boards/:slug/follow", h.boardState)
	g.PUT("/boards/:slug/follow", h.followBoard)
	g.DELETE("/boards/:slug/follow", h.unfollowBoard)
	g.GET("/users/:handle/follow", h.userState)
	g.PUT("/users/:handle/follow", h.followUser)
	g.DELETE("/users/:handle/follow", h.unfollowUser)
	// 「我关注的」两档。路径与 GET /me/appeals（appeal 域）、GET /me/bookmarks（forum 域）同一族。
	g.GET("/me/following/boards", h.myBoards)
	g.GET("/me/following/users", h.myUsers)
}

type pageQuery struct {
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit"`
}

// actorID 取当前用户 id；未登录返回 0。
// 公开读那两条走它 —— **未登录不是错误**（following 恒 false，关注数照给）。
func (h *Handler) actorID(c *gin.Context) int64 {
	if h.actorOf == nil {
		return 0
	}
	if a, ok := h.actorOf(c); ok && a != nil {
		return a.UserID
	}
	return 0
}

// mustActor 给 requireLogin 后面的路由用：拿不到身份就是 401（中间件已经挡过，这里是兜底）。
func (h *Handler) mustActor(c *gin.Context) (int64, bool) {
	id := h.actorID(c)
	if id == 0 {
		httpx.Fail(c, apperr.ErrUnauthorized)
		return 0, false
	}
	return id, true
}

// ── 公开读 ──────────────────────────────────────────────────────────────

func (h *Handler) boardFollowers(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := h.svc.Followers(c.Request.Context(), TargetBoard, c.Param("slug"), ListInput(q))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

func (h *Handler) userFollowers(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := h.svc.Followers(c.Request.Context(), TargetUser, c.Param("handle"), ListInput(q))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

// ── 分区：状态 / 关注 / 取关 ─────────────────────────────────────────────

func (h *Handler) boardState(c *gin.Context) {
	st, err := h.svc.BoardState(c.Request.Context(), h.actorID(c), c.Param("slug"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

func (h *Handler) followBoard(c *gin.Context) {
	me, ok := h.mustActor(c)
	if !ok {
		return
	}
	st, err := h.svc.FollowBoard(c.Request.Context(), me, c.Param("slug"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

func (h *Handler) unfollowBoard(c *gin.Context) {
	me, ok := h.mustActor(c)
	if !ok {
		return
	}
	st, err := h.svc.UnfollowBoard(c.Request.Context(), me, c.Param("slug"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

// ── 用户：状态 / 关注 / 取关 ─────────────────────────────────────────────

func (h *Handler) userState(c *gin.Context) {
	st, err := h.svc.UserState(c.Request.Context(), h.actorID(c), c.Param("handle"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

func (h *Handler) followUser(c *gin.Context) {
	me, ok := h.mustActor(c)
	if !ok {
		return
	}
	st, err := h.svc.FollowUser(c.Request.Context(), me, c.Param("handle"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

func (h *Handler) unfollowUser(c *gin.Context) {
	me, ok := h.mustActor(c)
	if !ok {
		return
	}
	st, err := h.svc.UnfollowUser(c.Request.Context(), me, c.Param("handle"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

// ── 我关注的 ────────────────────────────────────────────────────────────

func (h *Handler) myBoards(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	me, ok := h.mustActor(c)
	if !ok {
		return
	}
	page, err := h.svc.MyBoards(c.Request.Context(), me, ListInput(q))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

func (h *Handler) myUsers(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	me, ok := h.mustActor(c)
	if !ok {
		return
	}
	page, err := h.svc.MyUsers(c.Request.Context(), me, ListInput(q))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}
