package forum

import (
	"github.com/gin-gonic/gin"

	"forum/internal/platform/httpx"
)

// 用户组管理的 handler（D38）。与 handler_admin_boards.go 同一套四件事。

func (h *Handler) adminListGroups(c *gin.Context) {
	items, err := h.svc.AdminListGroups(c.Request.Context(), h.actor(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

type createGroupBody struct {
	Key         string `json:"key" binding:"required"`
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
}

func (h *Handler) adminCreateGroup(c *gin.Context) {
	var b createGroupBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.AdminCreateGroup(c.Request.Context(), h.actor(c), CreateGroupInput{
		Key: b.Key, Name: b.Name, Description: b.Description,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

// updateGroupBody 全是指针：nil = 没给（与 updateBoardBody 同一套约定）。**没有 key**。
type updateGroupBody struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

func (h *Handler) adminUpdateGroup(c *gin.Context) {
	var b updateGroupBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.AdminUpdateGroup(c.Request.Context(), h.actor(c), c.Param("id"), UpdateGroupInput{
		Name: b.Name, Description: b.Description,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) adminDeleteGroup(c *gin.Context) {
	if err := h.svc.AdminDeleteGroup(c.Request.Context(), h.actor(c), c.Param("id")); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h *Handler) adminGroupMembers(c *gin.Context) {
	items, err := h.svc.AdminGroupMembers(c.Request.Context(), h.actor(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

type addGroupMemberBody struct {
	UserID string `json:"user_id" binding:"required"`
}

func (h *Handler) adminAddGroupMember(c *gin.Context) {
	var b addGroupMemberBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	items, err := h.svc.AdminAddGroupMember(c.Request.Context(), h.actor(c), c.Param("id"), b.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

func (h *Handler) adminRemoveGroupMember(c *gin.Context) {
	items, err := h.svc.AdminRemoveGroupMember(c.Request.Context(), h.actor(c), c.Param("id"), c.Param("uid"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

// ---- 分区 × 组 ACL ----

func (h *Handler) adminBoardGroupACL(c *gin.Context) {
	items, err := h.svc.AdminBoardGroupACL(c.Request.Context(), h.actor(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

type replaceGroupACLBody struct {
	ACLs []AdminGroupACLItem `json:"acls"`
}

func (h *Handler) adminReplaceBoardGroupACL(c *gin.Context) {
	var b replaceGroupACLBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	items, err := h.svc.ReplaceBoardGroupACL(c.Request.Context(), h.actor(c), c.Param("id"), b.ACLs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}