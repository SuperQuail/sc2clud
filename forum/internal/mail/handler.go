package mail

import (
	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// ActorFunc 由 app 层提供：从 gin 上下文取当前 Actor（接线时传 auth.FromGin）。
type ActorFunc func(c *gin.Context) (*authz.Actor, bool)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。
type Handler struct {
	svc   *Service
	actor ActorFunc
}

func NewHandler(svc *Service, actor ActorFunc) *Handler {
	return &Handler{svc: svc, actor: actor}
}

// Register 挂载发信域的全部路由（都在 /admin 下，权限点 mail.manage）。
// 调用方（app 层）：
//
//	mail.NewHandler(svc, auth.FromGin).Register(v1, authSvc.RequireLogin, authSvc.Perm)
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin func() gin.HandlerFunc, perm func(...string) gin.HandlerFunc) {
	// 非 uuid 的 {id} 一律在进 service 之前挡成 400（见 platform/httpx.ValidPathIDs）。
	rg = rg.Group("", httpx.ValidPathIDs("id"))

	admin := rg.Group("/admin", requireLogin())
	admin.GET("/mail/accounts", perm(authz.PermMailManage), h.list)
	admin.POST("/mail/accounts", perm(authz.PermMailManage), h.create)
	admin.PATCH("/mail/accounts/:id", perm(authz.PermMailManage), h.update)
	admin.DELETE("/mail/accounts/:id", perm(authz.PermMailManage), h.remove)
	admin.POST("/mail/accounts/:id/test", perm(authz.PermMailManage), h.sendTest)

	// 邮件模板（D37）：权限点 site.setting（配置档与站点设置同源，不新造权限点）。
	tpl := admin.Group("/mail-templates", perm(authz.PermSiteSetting))
	tpl.GET("", h.listTemplates)
	tpl.PUT("/:kind", h.putTemplate)
	tpl.DELETE("/:kind", h.deleteTemplate)
	tpl.POST("/preview", h.previewTemplate)
}

func (h *Handler) list(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ListAccounts(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) create(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in AccountInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.CreateAccount(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) update(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in AccountPatch
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.UpdateAccount(c.Request.Context(), actor, c.Param("id"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) remove(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.DeleteAccount(c.Request.Context(), actor, c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) sendTest(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in SendTestInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.SendTest(c.Request.Context(), actor, c.Param("id"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	c.JSON(202, gin.H{"data": out})
}

// require 是登录端点的取 actor：拿不到就是 401。
func (h *Handler) require(c *gin.Context) (*authz.Actor, error) {
	actor, ok := h.actor(c)
	if !ok || actor == nil {
		return nil, apperr.ErrUnauthorized
	}
	return actor, nil
}

// ---- 邮件模板（D37）----

func (h *Handler) listTemplates(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ListTemplates(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) putTemplate(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in TemplateInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.PutTemplate(c.Request.Context(), actor, c.Param("kind"), in, c.ClientIP())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) deleteTemplate(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.DeleteTemplate(c.Request.Context(), actor, c.Param("kind"), c.ClientIP())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// TemplatePreviewInput 是预览的入参：kind 必填，三段**可选** —— 编辑框里改到一半的那份
// 直接送进来实渲染；空的段回落内置（不做「三段必须全齐」的强制，管理员可能只想换正文）。
type TemplatePreviewInput struct {
	Kind     string `json:"kind" binding:"required"`
	Subject  string `json:"subject"`
	HTMLBody string `json:"html_body"`
	TextBody string `json:"text_body"`
}

func (h *Handler) previewTemplate(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in TemplatePreviewInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.PreviewTemplate(c.Request.Context(), actor, in.Kind,
		&TemplateInput{Subject: in.Subject, HTMLBody: in.HTMLBody, TextBody: in.TextBody})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}
