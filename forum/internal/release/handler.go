package release

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。
// 业务分支一律在 service 里（拍板 §5.4）。
type Handler struct {
	svc   *Service
	actor ActorFunc
}

func NewHandler(svc *Service, actor ActorFunc) *Handler {
	return &Handler{svc: svc, actor: actor}
}

// Register 挂 /api/v1 下的路由。管理端三条用 perm(authz.PermSiteSetting)（21.2 没有更细的权限点）。
// 调用方（app 层）：
//
//	release.NewHandler(svc, authAdapter).Register(v1, requireLogin, perm)
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin, perm func(...string) gin.HandlerFunc) {
	// 非 uuid 的 {id} 一律在进 service 之前挡成 400（见 platform/httpx.ValidPathIDs）。
	rg = rg.Group("", httpx.ValidPathIDs("id"))

	rg.GET("/launcher/latest", h.latest)
	rg.GET("/launcher/releases", h.listReleases)
	rg.GET("/launcher/assets/:id/go", h.goAsset)

	admin := rg.Group("/admin/launcher", requireLogin())
	admin.POST("/releases", perm(authz.PermSiteSetting), h.upsertRelease)
	admin.PATCH("/releases/:id", perm(authz.PermSiteSetting), h.setReleaseStatus)
	admin.POST("/assets", perm(authz.PermSiteSetting), h.upsertAsset)
	admin.DELETE("/assets/:id", perm(authz.PermSiteSetting), h.deleteAsset)
}

func (h *Handler) latest(c *gin.Context) {
	out, err := h.svc.Latest(c.Request.Context(), c.Query("channel"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) listReleases(c *gin.Context) {
	var in ListReleasesInput
	if err := httpx.BindQuery(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ListReleases(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out.Items, out.NextCursor)
}

// goAsset 是 302 转链的落点（public_id → 外部直链）。计数在 service 里加。
func (h *Handler) goAsset(c *gin.Context) {
	target, err := h.svc.ResolveAsset(c.Request.Context(), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Redirect(http.StatusFound, target)
}

func (h *Handler) upsertRelease(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in UpsertReleaseInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.UpsertRelease(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) setReleaseStatus(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in struct {
		Status string `json:"status"`
	}
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	err = h.svc.SetReleaseStatus(c.Request.Context(), actor, SetReleaseStatusInput{ID: c.Param("id"), Status: in.Status})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) upsertAsset(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in UpsertAssetInput
	if err := httpx.Bind(c, &in); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.UpsertAsset(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) deleteAsset(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.DeleteAsset(c.Request.Context(), actor, c.Param("id")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) require(c *gin.Context) (*authz.Actor, error) {
	actor, ok := h.actor(c)
	if !ok || actor == nil {
		return nil, apperr.ErrUnauthorized
	}
	return actor, nil
}
