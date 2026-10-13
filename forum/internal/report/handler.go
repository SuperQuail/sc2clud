package report

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

// Register 挂载举报域的全部路由。limit 是限流中间件工厂（v2 §9.4：report:create 10 次/小时）。
// 调用方（app 层）：
//
//	report.NewHandler(svc, auth.FromGin).Register(v1, authSvc.RequireLogin, authSvc.Perm, ratelimitMW)
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin func() gin.HandlerFunc,
	perm func(...string) gin.HandlerFunc, limit func(string, gin.HandlerFunc) gin.HandlerFunc) {
	rg.POST("/reports", requireLogin(), limit("report:create", h.create))

	me := rg.Group("/me", requireLogin())
	me.GET("/reports", h.mine)

	admin := rg.Group("/admin", requireLogin())
	admin.GET("/reports", perm(authz.PermReportHandle), h.queue)
	admin.PATCH("/reports/:id", perm(authz.PermReportHandle), h.handle)
	admin.POST("/reports/batch", perm(authz.PermReportHandle), h.handleBatch)
}

func (h *Handler) create(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in CreateReportInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Create(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// 新建 201；重复举报 200 + 既有那条（拍板 §8.11 U5）
	if out.Created {
		httpx.Created(c, out)
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
	var in CursorInput
	if err := httpx.BindQuery(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ListMine(c.Request.Context(), actor, in)
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
	out, err := h.svc.ListQueue(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

func (h *Handler) handle(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in HandleInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.Handle(c.Request.Context(), actor, c.Param("id"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) handleBatch(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in BatchHandleInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	in.IP = c.ClientIP()
	out, err := h.svc.HandleBatch(c.Request.Context(), actor, in)
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
