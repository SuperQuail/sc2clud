package user

import (
	"strconv"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/httpx"
)

// Handler 只做：绑定 → 调 service → httpx.OK/Fail。
type Handler struct{ svc *Service }

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// Register 挂本模块的两条读路由。两条都**不需要登录**（公开资料）。
// 依赖：只有 *Service（它由 app 层用 ent client + media 的 AvatarURL 组装）。
func (h *Handler) Register(rg *gin.RouterGroup) {
	rg.GET("/users/search", h.search)
	rg.GET("/users/:handle", h.profile)
}

func (h *Handler) profile(c *gin.Context) {
	out, err := h.svc.GetProfile(c.Request.Context(), c.Param("handle"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) search(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	items, err := h.svc.Search(c.Request.Context(), c.Query("q"), limit)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, items)
}
