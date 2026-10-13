package media

import (
	"errors"
	"io"
	"net/http"
	"strings"

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

// Register 挂 /api/v1 下的路由。bodyLimit 传 nil 时沿用全局默认（拍板 §9.6：按路由设上限，
// 不许全局一刀切——三个上传端点的上限是 64KiB / 2MiB / 512KiB）。
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin, perm func(...string) gin.HandlerFunc, bodyLimit func(int64) gin.HandlerFunc) {
	limit := func(n int64) []gin.HandlerFunc {
		if bodyLimit == nil {
			return nil
		}
		return []gin.HandlerFunc{bodyLimit(n)}
	}

	me := rg.Group("/me", requireLogin())
	me.POST("/avatar", append(limit(h.svc.cfg.AvatarMax+formSlack), h.uploadAvatar)...)
	me.DELETE("/avatar", h.clearAvatar)
	me.POST("/payment-channels", append(limit(h.svc.cfg.PaymentMax+formSlack), h.addPaymentChannel)...)
	me.GET("/payment-channels", h.listPaymentChannels)
	me.DELETE("/payment-channels/:id", h.deletePaymentChannel)

	rg.POST("/topics/:id/images",
		append([]gin.HandlerFunc{requireLogin(), perm(authz.PermTopicCreate)},
			append(limit(h.svc.cfg.PostMax+formSlack), h.attachTopicImage)...)...)
	rg.DELETE("/topics/:id/images/:hash", requireLogin(), h.detachTopicImage)

	// 收款码的渠道读端点由 reward 域提供（GET /users/:handle/channels）；
	// 它需要 urlOf，本模块在这里把同一份拼接点暴露给它（见 URLOf）。
}

// ServeImage 挂**根**路由组（不在 /api/v1 下，d5 §1.4）。
// app 层：r.GET("/img/:hash", h.ServeImage)
func (h *Handler) ServeImage(c *gin.Context) {
	actor := h.optional(c)
	out, err := h.svc.FetchImage(c.Request.Context(), actor, c.Param("hash"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if out.Placeholder != nil {
		c.Header("Cache-Control", "no-store")
		c.Header("X-Img-Denied", "1")
		c.Data(http.StatusOK, out.Mime, out.Placeholder)
		return
	}
	c.Header("Content-Type", out.Mime)
	if out.Cache {
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		c.Header("Cache-Control", "no-store")
	}
	if out.Body != nil {
		defer func() { _ = out.Body.Close() }()
		c.Status(http.StatusOK)
		_, _ = io.Copy(c.Writer, out.Body)
		return
	}
	// 生产：交给 nginx 直出（它按上游给的 Content-Type 发，types{} 已清空 mime.types）
	c.Header("X-Accel-Redirect", "/_img/"+out.Path)
	c.Status(http.StatusOK)
	c.Writer.WriteHeaderNow()
}

func (h *Handler) uploadAvatar(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := readFormFile(c, "file", h.svc.cfg.AvatarMax+formSlack)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.UploadAvatar(c.Request.Context(), actor, UploadAvatarInput{Body: body})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if out.Created {
		httpx.Created(c, out)
		return
	}
	httpx.OK(c, out)
}

func (h *Handler) clearAvatar(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.ClearAvatar(c.Request.Context(), actor); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) attachTopicImage(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := readFormFile(c, "file", h.svc.cfg.PostMax+formSlack)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.AttachTopicImage(c.Request.Context(), actor, AttachTopicImageInput{
		TopicPublicID: c.Param("id"),
		Body:          body,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) detachTopicImage(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	err = h.svc.DetachTopicImage(c.Request.Context(), actor, DetachTopicImageInput{
		TopicPublicID: c.Param("id"),
		Hash:          c.Param("hash"),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handler) addPaymentChannel(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := readFormFile(c, "file", h.svc.cfg.PaymentMax+formSlack)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.AddPaymentChannel(c.Request.Context(), actor, AddPaymentChannelInput{
		Label: c.PostForm("label"),
		Body:  body,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

func (h *Handler) listPaymentChannels(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ListPaymentChannels(c.Request.Context(), actor, c.Query("user"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OKList(c, out, "")
}

func (h *Handler) deletePaymentChannel(c *gin.Context) {
	actor, err := h.require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.DeletePaymentChannel(c.Request.Context(), actor, c.Param("id")); err != nil {
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

func (h *Handler) optional(c *gin.Context) *authz.Actor {
	actor, ok := h.actor(c)
	if !ok {
		return nil
	}
	return actor
}

// formSlack 是 multipart 表单头（boundary、文件名、字段名）的余量（d5 §3.1）。
const formSlack = 4 << 10

// readFormFile 取 multipart 里的一个文件字段。
// 服务端判的是**读到的真实字节数**，不是 Content-Length、不是 part.Header（客户端说什么都不算）。
func readFormFile(c *gin.Context, field string, max int64) ([]byte, error) {
	fh, err := c.FormFile(field)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, ErrTooLarge
		}
		if strings.Contains(err.Error(), "request body too large") {
			return nil, ErrTooLarge
		}
		return nil, invalid(field, "请选择要上传的图片")
	}
	if fh.Size > max {
		return nil, ErrTooLarge
	}
	f, err := fh.Open()
	if err != nil {
		return nil, invalid(field, "图片读取失败")
	}
	defer func() { _ = f.Close() }()
	body, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, ErrTooLarge
		}
		return nil, invalid(field, "图片读取失败")
	}
	if int64(len(body)) > max {
		return nil, ErrTooLarge
	}
	return body, nil
}
