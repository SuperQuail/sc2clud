package reward

import (
	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// ActorFunc 由 app 层提供：从 gin 上下文取当前 Actor。
// 本模块不依赖 auth 包的中间件名，只依赖这个函数（接线时传 auth.FromGin 的适配）。
type ActorFunc func(c *gin.Context) (*authz.Actor, bool)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。
// 业务分支一律在 service 里（拍板 §5.4）。
type Handler struct {
	svc   *Service
	actor ActorFunc
}

func NewHandler(svc *Service, actor ActorFunc) *Handler {
	return &Handler{svc: svc, actor: actor}
}

// Register 挂载赞赏模块的全部路由。perm 是 app 层的权限中间件，要求权限点的作用域由它兜住。
// limit 是限流中间件工厂：limit("reward:create", ...) 包住申报与核验端点（v2 §9.4）。
// 调用方（app 层）：
//
//	reward.NewHandler(svc, authAdapter).Register(v1, requireLogin, perm, limit)
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin, perm func(...string) gin.HandlerFunc, limit func(string, gin.HandlerFunc) gin.HandlerFunc) {
	// 路径参数的闸：**公开读挂组上，写路由挂在「身份 → 权限」之后**（拍板 08 · C9-3）。
	// 顺序差决定未登录的非 uuid 请求拿 401 还是 400：读路径没有身份可验，格式先判（400，C9-1）；
	// 写路径先吃 requireLogin（未登录 → 401），登录了才轮到格式判定（→ 400）。
	read := rg.Group("", httpx.ValidPathIDs("id"))

	user := read.Group("/users/:handle")
	user.GET("/channels", h.channels)
	user.GET("/rewards", h.userDonations)

	me := read.Group("/me", requireLogin())
	me.GET("/rewards", h.myDonations)
	me.GET("/donation-settings", h.getSettings)
	me.PATCH("/donation-settings", h.updateSettings)

	// 写路由逐条挂闸：路径闸的位置就在 requireLogin 之后、handler 之前。
	rg.POST("/rewards", requireLogin(), httpx.ValidPathIDs("id"), limit("reward:create", h.create))
	rg.DELETE("/rewards/:id", requireLogin(), httpx.ValidPathIDs("id"), h.withdraw)

	rg.GET("/admin/rewards", requireLogin(), perm(authz.PermRewardVerify), h.queue)
	rg.POST("/admin/rewards/:id/verify", requireLogin(), perm(authz.PermRewardVerify), httpx.ValidPathIDs("id"), limit("reward:verify", h.verify))
	rg.POST("/admin/rewards/batch", requireLogin(), perm(authz.PermRewardVerify), h.verifyBatch)
	rg.GET("/admin/rewards/stats", requireLogin(), perm(authz.PermRewardVerify), h.stats)
	rg.GET("/admin/donation-notice-defaults", requireLogin(), perm(authz.PermSiteSetting), h.noticeDefaults)
	rg.PATCH("/admin/donation-notice-defaults", requireLogin(), perm(authz.PermSiteSetting), h.updateNoticeDefaults)
}

func (h *Handler) channels(c *gin.Context) {
	out, err := h.svc.Channels(c.Request.Context(), h.optional(c), c.Param("handle"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) userDonations(c *gin.Context) {
	var in UserDonationsInput
	if err := httpx.BindQuery(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.Handle = c.Param("handle")
	out, err := h.svc.ListUserDonations(c.Request.Context(), h.optional(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

func (h *Handler) myDonations(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in CursorInput
	if err := httpx.BindQuery(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ListMyDonations(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

func (h *Handler) create(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in CreateDonationInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.CreateDonation(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) withdraw(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.WithdrawDonation(c.Request.Context(), actor, c.Param("id")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) getSettings(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.GetMySettings(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) updateSettings(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in UpdateDonationSettingsInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.UpdateMySettings(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
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
	out, err := h.svc.ListQueue(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

func (h *Handler) verify(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in VerifyInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.Verify(c.Request.Context(), actor, c.Param("id"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) verifyBatch(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in BatchVerifyInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.VerifyBatch(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) stats(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in StatsInput
	if err := httpx.BindQuery(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Stats(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) noticeDefaults(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.GetNoticeDefaults(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) updateNoticeDefaults(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in NoticeDefaultsInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.UpdateNoticeDefaults(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// require 是「登录端点」的取 actor：拿不到就是 401（handler 不做别的判断）。
func (h *Handler) require(c *gin.Context) (*authz.Actor, error) {
	actor, ok := h.actor(c)
	if !ok || actor == nil {
		return nil, apperr.ErrUnauthorized
	}
	return actor, nil
}

// optional 是游客可读端点的取 actor：没登录就是 nil，service 自己决定游客能看到什么。
func (h *Handler) optional(c *gin.Context) *authz.Actor {
	actor, ok := h.actor(c)
	if !ok {
		return nil
	}
	return actor
}
