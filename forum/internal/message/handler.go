package message

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/httpx"
)

type Handler struct {
	svc     *Service
	actorOf ActorFromGin
}

func NewHandler(svc *Service, actorOf ActorFromGin) *Handler {
	return &Handler{svc: svc, actorOf: actorOf}
}

// Register 挂 /api/v1/messages/*（d4 §3.4）。
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc) {
	// 非 uuid 的 {id} 一律在进 service 之前挡成 400（见 platform/httpx.ValidPathIDs）。
	rg = rg.Group("", httpx.ValidPathIDs("id"))

	g := rg.Group("/messages", requireLogin)
	g.GET("", h.listConversations)
	g.GET("/unread-count", h.unreadTotal)
	g.GET("/:handle", h.listThread)
	g.POST("/:handle", h.send)
	g.POST("/:handle/read", h.markRead)
	g.DELETE("/:id", h.remove)
}

type pageQuery struct {
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit"`
}

func (h *Handler) listConversations(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	page, err := h.svc.ListConversations(c.Request.Context(), actor, PageInput{Cursor: q.Cursor, Limit: q.Limit})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, page.Items, page.NextCursor)
}

func (h *Handler) unreadTotal(c *gin.Context) {
	actor, _ := h.actorOf(c)
	n, err := h.svc.UnreadTotal(c.Request.Context(), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"count": n})
}

func (h *Handler) listThread(c *gin.Context) {
	var q pageQuery
	if err := httpx.BindQuery(c, &q); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	page, err := h.svc.ListThread(c.Request.Context(), actor, ThreadInput{
		PeerHandle: c.Param("handle"), Cursor: q.Cursor, Limit: q.Limit,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// d4 §5.2 的形状是 { data: [...], next_cursor, peer }：httpx.OKList 只给前两个字段，
	// 所以这一处直接写包络（要 peer 才能在没有会话列表时也渲染出会话头）。
	writeThreadPage(c, page.Items, page.NextCursor, page.Peer)
}

type sendBody struct {
	Body string `json:"body"`
}

func (h *Handler) send(c *gin.Context) {
	var b sendBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	msg, err := h.svc.Send(c.Request.Context(), actor, SendInput{PeerHandle: c.Param("handle"), Body: b.Body})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, msg)
}

func (h *Handler) markRead(c *gin.Context) {
	actor, _ := h.actorOf(c)
	n, err := h.svc.MarkThreadRead(c.Request.Context(), actor, c.Param("handle"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"updated": n})
}

func (h *Handler) remove(c *gin.Context) {
	actor, _ := h.actorOf(c)
	if err := h.svc.DeleteMessage(c.Request.Context(), actor, c.Param("id")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func writeThreadPage(c *gin.Context, items any, next string, peer UserBrief) {
	if next == "" {
		c.JSON(http.StatusOK, gin.H{"data": items, "next_cursor": nil, "peer": peer})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": items, "next_cursor": next, "peer": peer})
}
