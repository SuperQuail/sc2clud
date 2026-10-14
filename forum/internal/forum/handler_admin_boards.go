package forum

import (
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// 分区管理的 handler（C2）。仍然只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。


// ── 分区管理（C2） ───────────────────────────────────────────────
// handler 仍然只做四件事：绑定 → 取 actor → 调 service → httpx.OK/Created/Fail。

func (h *Handler) adminListBoards(c *gin.Context) {
	items, err := h.svc.AdminListBoards(c.Request.Context(), h.actor(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

type createBoardBody struct {
	Slug         string  `json:"slug" binding:"required"`
	Name         string  `json:"name" binding:"required"`
	Description  string  `json:"description"`
	Status       string  `json:"status"`
	ACLEnabled   bool    `json:"acl_enabled"`
	MinPostLevel int     `json:"min_post_level"`
	CoverHash    *string `json:"cover_hash"`
}

func (h *Handler) adminCreateBoard(c *gin.Context) {
	var b createBoardBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.CreateBoard(c.Request.Context(), h.actor(c), CreateBoardInput{
		Slug: b.Slug, Name: b.Name, Description: b.Description, Status: b.Status,
		ACLEnabled: b.ACLEnabled, MinPostLevel: b.MinPostLevel, CoverHash: b.CoverHash,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

// updateBoardBody 全是**指针**：nil = 没给这个字段（与 UpdateTopicInput 同一套约定）。
type updateBoardBody struct {
	Name         *string `json:"name"`
	Description  *string `json:"description"`
	Status       *string `json:"status"`
	ACLEnabled   *bool   `json:"acl_enabled"`
	MinPostLevel *int    `json:"min_post_level"`
	CoverHash    *string `json:"cover_hash"`
}

func (h *Handler) adminUpdateBoard(c *gin.Context) {
	var b updateBoardBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.UpdateBoard(c.Request.Context(), h.actor(c), c.Param("id"), UpdateBoardInput{
		Name: b.Name, Description: b.Description, Status: b.Status,
		ACLEnabled: b.ACLEnabled, MinPostLevel: b.MinPostLevel, CoverHash: b.CoverHash,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

type reorderBoardsBody struct {
	IDs []string `json:"ids" binding:"required"`
}

func (h *Handler) adminReorderBoards(c *gin.Context) {
	var b reorderBoardsBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.ReorderBoards(c.Request.Context(), h.actor(c), b.IDs); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h *Handler) adminBoardACL(c *gin.Context) {
	items, err := h.svc.AdminBoardACL(c.Request.Context(), h.actor(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

type replaceACLBody struct {
	ACLs []AdminACLItem `json:"acls"`
}

func (h *Handler) adminReplaceBoardACL(c *gin.Context) {
	var b replaceACLBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	items, err := h.svc.ReplaceBoardACL(c.Request.Context(), h.actor(c), c.Param("id"), b.ACLs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

func (h *Handler) adminBoardModerators(c *gin.Context) {
	items, err := h.svc.AdminBoardModerators(c.Request.Context(), h.actor(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

// grantModeratorBody 的 expires_at 是 RFC3339；空 = 永久（DB 允许 NULL）。
type grantModeratorBody struct {
	UserID    string `json:"user_id" binding:"required"`
	ExpiresAt string `json:"expires_at"`
}

func (h *Handler) adminGrantBoardModerator(c *gin.Context) {
	var b grantModeratorBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	expires, err := parseTimePtr(b.ExpiresAt)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	items, err := h.svc.GrantBoardModerator(c.Request.Context(), h.actor(c), c.Param("id"), b.UserID, expires)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

// parseTimePtr 解 RFC3339；空串 = 没给（nil）。
// 与 auth 域的同名函数各持一份：两个域不许互相 import，而这是三行的纯函数。
func parseTimePtr(s string) (*time.Time, error) {
	if s == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return nil, apperr.Invalid(map[string]string{"expires_at": "时间格式必须是 RFC3339"})
	}
	return &t, nil
}

func (h *Handler) adminRevokeBoardModerator(c *gin.Context) {
	err := h.svc.RevokeBoardModerator(c.Request.Context(), h.actor(c), c.Param("id"), c.Param("uid"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}
