package aireview

import (
	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// ActorFunc 由 app 层提供：从 gin 上下文取当前 Actor（接线时传 auth.FromGin）。
type ActorFunc func(c *gin.Context) (*authz.Actor, bool)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Fail。
type Handler struct {
	svc   *Service
	actor ActorFunc
}

func NewHandler(svc *Service, actor ActorFunc) *Handler {
	return &Handler{svc: svc, actor: actor}
}

// Register 挂载 AI 审核的四个 admin 端点（d7 §8）。权限点沿用 site.setting，**不新造权限点**。
//
// 调用方（app 层）：
//
//	aireview.NewHandler(m.AIReview, auth.FromGin).Register(v1, authSvc.RequireLogin, authSvc.Perm)
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin func() gin.HandlerFunc, perm func(...string) gin.HandlerFunc) {
	admin := rg.Group("/admin", requireLogin())
	admin.GET("/ai/config", perm(authz.PermSiteSetting), h.getConfig)
	admin.PATCH("/ai/config", perm(authz.PermSiteSetting), h.patchConfig)
	admin.POST("/ai/config/secret", perm(authz.PermSiteSetting), h.saveSecret)
	admin.POST("/ai/test", perm(authz.PermSiteSetting), h.test)
}

// getConfig 的回执里**没有密钥字段**（d7 §8：密钥永不回显，只有 has_secret 与 secret_updated_at）。
func (h *Handler) getConfig(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	cfg, err := h.svc.GetConfig(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, viewOf(cfg))
}

// patchConfig 只写传进来的字段；密钥**不在这个请求体里**（它走 /config/secret）。
func (h *Handler) patchConfig(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	var in ConfigPatch
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	ctx := c.Request.Context()
	if err := h.svc.UpdateConfig(ctx, in.toInput()); err != nil {
		httpx.Fail(c, err)
		return
	}
	cfg, err := h.svc.GetConfig(ctx)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, viewOf(cfg))
}

// saveSecret 是密钥的唯一写入口。**只写不回显**：回执里连 has_secret 之外什么都不给。
func (h *Handler) saveSecret(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	var in SecretInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	if in.APIKey == "" {
		httpx.Fail(c, apperr.Invalid(map[string]string{"api_key": "不能为空"}))
		return
	}
	if err := h.svc.SaveKey(c.Request.Context(), in.APIKey); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"has_secret": true})
}

// test 是「测试连通」：真发一次请求，回耗时 / 实际模型名 / 原始 verdict（d7 §8）。
func (h *Handler) test(c *gin.Context) {
	if _, err := h.require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Test(c.Request.Context())
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
