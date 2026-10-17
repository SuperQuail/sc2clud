package site

import (
	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// ActorFunc 由 app 层提供：从 gin 上下文取当前 Actor（接线时传 auth.FromGin）。
// 本模块不依赖 auth 包，只依赖这个函数。
type ActorFunc func(c *gin.Context) (*authz.Actor, bool)

// maxPreviewBody 是 Markdown 预览的请求体上限（v2 §9.6：正文可以很长，本域其余路由走全局 1MB）。
const maxPreviewBody = 2 << 20

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。
// 业务分支一律在 service 里（拍板 §5.4）。
type Handler struct {
	svc   *Service
	actor ActorFunc
}

func NewHandler(svc *Service, actor ActorFunc) *Handler {
	return &Handler{svc: svc, actor: actor}
}

// Register 挂载站点域的全部路由。perm 是 app 层的权限中间件（要求权限点）。
// 调用方（app 层）：
//
//	site.NewHandler(svc, auth.FromGin).Register(v1, authSvc.RequireLogin, authSvc.Perm)
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin func() gin.HandlerFunc, perm func(...string) gin.HandlerFunc) {
	// 非 uuid 的 {id} 一律在进 service 之前挡成 400（见 platform/httpx.ValidPathIDs）。
	rg = rg.Group("", httpx.ValidPathIDs("id"))

	rg.GET("/site", h.site)
	rg.POST("/banners/:id/dismiss", requireLogin(), h.dismiss)
	rg.POST("/markdown/preview", requireLogin(), httpx.BodyLimit(maxPreviewBody), h.preview)

	admin := rg.Group("/admin", requireLogin())
	admin.GET("/site-settings", perm(authz.PermSiteSetting), h.getSettings)
	admin.PATCH("/site-settings", perm(authz.PermSiteSetting), h.updateSettings)
	admin.GET("/site-domains", perm(authz.PermSiteSetting), h.domains)
	admin.GET("/announcements", perm(authz.PermSiteSetting), h.listAnnouncements)
	admin.POST("/announcements", perm(authz.PermSiteSetting), h.createAnnouncement)
	admin.PATCH("/announcements/:id", perm(authz.PermSiteSetting), h.updateAnnouncement)
	admin.GET("/banners", perm(authz.PermSiteSetting), h.listBanners)
	admin.POST("/banners", perm(authz.PermSiteSetting), h.createBanner)
	admin.PATCH("/banners/:id", perm(authz.PermSiteSetting), h.updateBanner)
}

func (h *Handler) site(c *gin.Context) {
	out, err := h.svc.GetSite(c.Request.Context(), h.optional(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) dismiss(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.DismissBanner(c.Request.Context(), actor, c.Param("id")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) preview(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in PreviewInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.RenderMarkdown(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) getSettings(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.GetSettings(c.Request.Context(), actor)
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
	var in SettingsInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	if err := h.svc.UpdateSettings(c.Request.Context(), actor, in); err != nil {
		httpx.Fail(c, err)
		return
	}
	// 返回新视图：前端用它刷新「已保存」态（d6 §6.7）
	out, err := h.svc.GetSettings(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) domains(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ListDomains(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) listAnnouncements(c *gin.Context) {
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
	out, err := h.svc.ListAnnouncements(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

func (h *Handler) createAnnouncement(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in AnnouncementInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.CreateAnnouncement(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) updateAnnouncement(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in AnnouncementPatch
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.UpdateAnnouncement(c.Request.Context(), actor, c.Param("id"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) listBanners(c *gin.Context) {
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
	out, err := h.svc.ListBanners(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

func (h *Handler) createBanner(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in BannerInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.CreateBanner(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) updateBanner(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in BannerPatch
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.UpdateBanner(c.Request.Context(), actor, c.Param("id"), in)
	if err != nil {
		httpx.Fail(c, err)
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

// optional 是游客可读端点的取 actor：没登录就是 nil，service 决定游客能看到什么。
func (h *Handler) optional(c *gin.Context) *authz.Actor {
	actor, ok := h.actor(c)
	if !ok {
		return nil
	}
	return actor
}
