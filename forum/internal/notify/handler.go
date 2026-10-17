package notify

import (
	"github.com/gin-gonic/gin"

	"forum/internal/platform/httpx"
)

// Handler 只做四件事：绑定 → 取 actor → 调 service → httpx 写响应（拍板 §5.3）。
type Handler struct {
	svc     *Service
	actorOf ActorFromGin
	// SSE 广播（L11，stream.go）。它是**进程内**的，与老站同一条取舍。
	hub *streamHub
}

func NewHandler(svc *Service, actorOf ActorFromGin) *Handler {
	h := &Handler{svc: svc, actorOf: actorOf, hub: newStreamHub()}
	// 把「有人写了通知」这条线接上：service 在写完之后调它，handler 负责扇出。
	// 在这之前（app 层还没建 handler 时）Create 走的是空实现，什么都不会发生 ——
	// 这是流式端点的接线代价：它需要状态，而 service 是无状态的。
	// svc 允许为 nil：路由用例只验路由表，不需要一个真 service（nil 时这条线不接，其余行为不变）。
	if svc != nil {
		svc.publish = h.hub.Publish
	}
	return h
}

// Register 挂 /api/v1/notifications/*（d4 §3.4）。
// 静态段 /mutes 必须先于通配 /:id 注册，否则 gin 的路由树会把 mutes 当成一个 id。
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc) {
	// 路径闸挂在**组内部**（requireLogin 之后）：本域全部路由都要登录，
	// 顺序天然是「先验身份再验路径 ID」（拍板 08 · C9-3）。
	// DELETE /notifications/{id} 的 id 是对外 uuid，非 uuid 放过去就是 22P02 → 500（C9-2）。
	g := rg.Group("/notifications", requireLogin, httpx.ValidPathIDs("id"))
	g.GET("", h.list)
	// 实时推送（L11）。静态段 /stream 与 /unread-count 都排在通配 /:id 之前（gin 的路由树）。
	g.GET("/stream", h.stream)
	g.GET("/unread-count", h.unreadCount)
	g.POST("/read", h.markRead)
	g.PUT("/mutes", h.setMute)
	g.DELETE("/mutes", h.unsetMute)
	g.GET("/settings", h.getSettings)
	g.PUT("/settings", h.putSettings)
	g.DELETE("/:id", h.remove)
}

// noticeSettingDTO 是消息设置的回执形状（JSON 字段名即契约，前端照抄）。
type noticeSettingDTO struct {
	Alert        bool   `json:"alert"`
	ReplyScope   string `json:"reply_scope"`
	MentionScope string `json:"mention_scope"`
	LikeAlert    bool   `json:"like_alert"`
}

func toSettingDTO(s *NoticeSetting) noticeSettingDTO {
	return noticeSettingDTO{Alert: s.Alert, ReplyScope: s.ReplyScope, MentionScope: s.MentionScope, LikeAlert: s.LikeAlert}
}

func (h *Handler) getSettings(c *gin.Context) {
	actor, _ := h.actorOf(c)
	s, err := h.svc.Settings(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, toSettingDTO(s))
}

func (h *Handler) putSettings(c *gin.Context) {
	var b noticeSettingDTO
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	s, err := h.svc.UpdateSettings(c.Request.Context(), actor, NoticeSetting{
		Alert: b.Alert, ReplyScope: b.ReplyScope, MentionScope: b.MentionScope, LikeAlert: b.LikeAlert,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, toSettingDTO(s))
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
