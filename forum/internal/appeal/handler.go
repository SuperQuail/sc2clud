package appeal

import (
	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// ActorFunc 由 app 层提供：从 gin 上下文取当前 Actor（接线时传 auth.FromGin）。
// **第二个返回值是 bool**（与 report 域一致）：免登录的 POST /appeals 需要区分
// 「游客」与「登录了」，而不是把两者都当成 401。
type ActorFunc func(c *gin.Context) (*authz.Actor, bool)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。
type Handler struct {
	svc   *Service
	actor ActorFunc
}

func NewHandler(svc *Service, actor ActorFunc) *Handler {
	return &Handler{svc: svc, actor: actor}
}

// HandlerFactory 是「给这次请求造一个 Handler」的形状。
//
// 为什么不是 NewHandler 一次挂完：本域的 Store 上带着「当前事务执行器」这一份可变状态
// （见 pgsql 的说明），一份共享的 Handler 会让并发的两个请求互相清掉对方的事务。
// 代价是每请求多几次分配 —— 与「事务被别的请求清掉」这种错相比，它便宜到可以忽略。
type HandlerFactory func(fn func(*Handler) gin.HandlerFunc) gin.HandlerFunc

// RegisterRoutes 是 app 层用的入口：它把每一条路由都包成「先造 Handler，再执行」。
func RegisterRoutes(rg *gin.RouterGroup, f HandlerFactory, requireLogin func() gin.HandlerFunc,
	perm func(...string) gin.HandlerFunc, limitIP func(string, ...gin.HandlerFunc) gin.HandlerFunc) {
	rg.POST("/appeals", f(func(h *Handler) gin.HandlerFunc { return limitIP("appeal:create", h.create) }))
	rg.POST("/appeals/lookup", f(func(h *Handler) gin.HandlerFunc { return limitIP("appeal:lookup", h.lookup) }))
	rg.GET("/me/appeals", f(func(h *Handler) gin.HandlerFunc { return chain(requireLogin(), h.mine) }))
	// 路径闸排在 requireLogin 之后（拍板 08 · C9-3：先验身份再验路径 ID）：
	// 未登录的非 uuid 请求拿 401，登录之后才是 400（C9-1 的语义统一）。
	rg.POST("/topics/:id/review/appeal", f(func(h *Handler) gin.HandlerFunc {
		return chain(requireLogin(), perm(authz.PermTopicCreate), httpx.ValidPathIDs("id"), h.appealReview)
	}))
	admin := rg.Group("/admin")
	admin.GET("/appeals", f(func(h *Handler) gin.HandlerFunc {
		return chain(requireLogin(), perm(permQueue), h.queue)
	}))
	admin.PATCH("/appeals", f(func(h *Handler) gin.HandlerFunc {
		return chain(requireLogin(), perm(permQueue), h.decide)
	}))
}

// chain 把中间件与最终 handler 串起来（gin 的 Use 只作用于组，单个路由要自己串）。
// 逐段判 IsAborted：前一个中间件拒绝（例如 403）之后不许再往下走。
func chain(mws ...gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		for _, mw := range mws {
			mw(c)
			if c.IsAborted() {
				return
			}
		}
	}
}

// Register 挂载申诉域的全部路由。
//
// **POST /appeals 与 POST /appeals/lookup 刻意不挂 requireLogin** —— 这正是 C4 存在的理由：
// 被封的人登不进来，任何要求登录的自证方式对他都是死路（盲审合并结论 §7）。
// 这两条路的人机闸门是图形验证码（service 层永远要求），额度是 24 小时 3 条。
//
// create 是 POST /appeals：**免登录**。登录了也照收（登录态是更强的证据，queue 里按 user_id 找人）。
// 202 而不是 201：单号已经发了，但这条申诉还在队列里等处理，没有「资源已经就绪」这层意思。
func (h *Handler) create(c *gin.Context) {
	actor, _ := h.actor(c) // 游客也是合法来客：不判 ok
	var in CreateInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.Create(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

// lookup 是免登录查进展（单号 + 邮箱）。
func (h *Handler) lookup(c *gin.Context) {
	var in LookupInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Lookup(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) mine(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in MineInput
	if err := httpx.BindQuery(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Mine(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

func (h *Handler) queue(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in QueueInput
	if err := httpx.BindQuery(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Queue(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

func (h *Handler) decide(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in DecideInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.Decide(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// appealReview 是 C5。幂等重放回 200（不是 202）：没有新建任何东西。
func (h *Handler) appealReview(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in ReviewAppealInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.AppealReview(c.Request.Context(), actor, c.Param("id"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if out.Created {
		httpx.Created(c, out)
		return
	}
	httpx.OK(c, out)
}

// require 是登录端点的取 actor：拿不到就是 401。
func (h *Handler) require(c *gin.Context) (*authz.Actor, error) {
	actor, ok := h.actor(c)
	if !ok || actor == nil {
		return nil, apperr.ErrUnauthorized
	}
	return actor, nil
}
