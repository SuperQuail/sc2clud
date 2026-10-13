package notify

import (
	"github.com/gin-gonic/gin"

	"forum/internal/platform/httpx"
)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx 写响应（拍板 §5.3）。
type Handler struct {
	svc     *Service
	actorOf ActorFromGin
}

func NewHandler(svc *Service, actorOf ActorFromGin) *Handler {
	return &Handler{svc: svc, actorOf: actorOf}
}

// Register 挂 /api/v1/notifications/*（d4 §3.4）。
// 静态段 /mutes 必须先于通配 /:id 注册，否则 gin 的路由树会把 mutes 当成一个 id。
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc) {
	g := rg.Group("/notifications", requireLogin)
	g.GET("", h.list)
	g.GET("/unread-count", h.unreadCount)
	g.POST("/read", h.markRead)
	g.PUT("/mutes", h.setMute)
	g.DELETE("/mutes", h.unsetMute)
	g.DELETE("/:id", h.remove)
}

type listQuery struct {
	Kind   string `form:"kind"`
	Unread bool   `form:"unread"`
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit"`
}

func (h *Handler) list(c *gin.Context) {
	var q listQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	res, err := h.svc.List(c.Request.Context(), actor, ListInput{
		Kind: q.Kind, UnreadOnly: q.Unread, Cursor: q.Cursor, Limit: q.Limit,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, res.Items, res.NextCursor)
}

func (h *Handler) unreadCount(c *gin.Context) {
	actor, _ := h.actorOf(c)
	n, err := h.svc.UnreadCount(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"count": n})
}

type markReadBody struct {
	IDs []string `json:"ids"`
	All bool     `json:"all"`
}

func (h *Handler) markRead(c *gin.Context) {
	var b markReadBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	n, err := h.svc.MarkRead(c.Request.Context(), actor, MarkReadInput{PublicIDs: b.IDs, All: b.All})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"updated": n})
}

type muteBody struct {
	Type    string `json:"type"`
	RefType string `json:"ref_type"`
	RefID   int64  `json:"ref_id"`
}

func (h *Handler) setMute(c *gin.Context) {
	var b muteBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	if err := h.svc.SetMute(c.Request.Context(), actor, MuteInput(b)); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) unsetMute(c *gin.Context) {
	var b muteBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	if err := h.svc.UnsetMute(c.Request.Context(), actor, MuteInput(b)); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) remove(c *gin.Context) {
	actor, _ := h.actorOf(c)
	if err := h.svc.Delete(c.Request.Context(), actor, c.Param("id")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}
