package title

import (
	"errors"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/httpx"
)

// PermMiddleware 是 D2 的 auth.Perm 的形状：按权限点造一个中间件。
type PermMiddleware func(perms ...string) gin.HandlerFunc

type Handler struct {
	svc     *Service
	users   UserLookup
	actorOf ActorFromGin
}

func NewHandler(svc *Service, users UserLookup, actorOf ActorFromGin) *Handler {
	return &Handler{svc: svc, users: users, actorOf: actorOf}
}

// Register 挂头衔相关的五条路由（d4 §3.4）。
// {id} 一律是 public_id（v2 §21.1）：/admin/users/{id} 是用户，/admin/titles/{id} 是头衔。
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc, perm PermMiddleware) {
	rg.GET("/titles", h.listTitles)
	rg.GET("/users/:handle/titles", h.userTitles)
	rg.PUT("/me/title", requireLogin, h.equip)

	a := rg.Group("/admin", requireLogin)
	a.POST("/users/:id/titles/:titleId", perm(authz.PermTitleGrant), h.grant)
	a.DELETE("/users/:id/titles/:titleId", perm(authz.PermTitleGrant), h.revoke)
	a.GET("/titles", perm(authz.PermTitleManage), h.adminList)
	a.POST("/titles", perm(authz.PermTitleManage), h.adminCreate)
	a.PATCH("/titles/:id", perm(authz.PermTitleManage), h.adminUpdate)
}

func (h *Handler) listTitles(c *gin.Context) {
	items, err := h.svc.ListTitles(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}

func (h *Handler) adminList(c *gin.Context) { h.listTitles(c) }

func (h *Handler) userTitles(c *gin.Context) {
	brief, err := h.users.ByUsername(c.Request.Context(), c.Param("handle"))
	if err != nil {
		httpx.Fail(c, userLookupError(err))
		return
	}
	out, err := h.svc.UserTitles(c.Request.Context(), brief.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

type equipBody struct {
	// nil 或 "" = 取消佩戴（d4 §5.3：title_id: null）
	TitleID *string `json:"title_id"`
}

func (h *Handler) equip(c *gin.Context) {
	var b equipBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	var id string
	if b.TitleID != nil {
		id = *b.TitleID
	}
	if err := h.svc.Equip(c.Request.Context(), actor, id); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) grant(c *gin.Context) {
	actor, _ := h.actorOf(c)
	brief, err := h.users.ByPublicID(c.Request.Context(), c.Param("id"))
	if err != nil {
		httpx.Fail(c, userLookupError(err))
		return
	}
	in := AssignInput{UserID: brief.ID, TitlePublicID: c.Param("titleId")}
	if err := h.svc.AssignTitle(c.Request.Context(), actor, in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) revoke(c *gin.Context) {
	actor, _ := h.actorOf(c)
	brief, err := h.users.ByPublicID(c.Request.Context(), c.Param("id"))
	if err != nil {
		httpx.Fail(c, userLookupError(err))
		return
	}
	in := AssignInput{UserID: brief.ID, TitlePublicID: c.Param("titleId"), Revoke: true}
	if err := h.svc.AssignTitle(c.Request.Context(), actor, in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

type titleBody struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
	Archived    bool   `json:"archived"`
}

func (b titleBody) input() TitleInput {
	return TitleInput{Key: b.Key, Name: b.Name, Color: b.Color, Description: b.Description, Archived: b.Archived}
}

func (h *Handler) adminCreate(c *gin.Context) {
	var b titleBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	dto, err := h.svc.CreateTitle(c.Request.Context(), actor, b.input())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, dto)
}

func (h *Handler) adminUpdate(c *gin.Context) {
	var b titleBody
	if err := httpx.Bind(c, &b); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := h.actorOf(c)
	in := b.input()
	in.PublicID = c.Param("id")
	dto, err := h.svc.UpdateTitle(c.Request.Context(), actor, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, dto)
}

// userLookupError 把注入的「查不到」约定值翻成 404（本包不 import user 包）。
func userLookupError(err error) error {
	if errors.Is(err, ErrUserNotFound) {
		return apperr.ErrNotFound
	}
	return err
}
