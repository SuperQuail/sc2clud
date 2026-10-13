package auth

import (
	"context"
	"encoding/base64"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/httpx"
)

// 图形验证码的端点与限流（设计 d2-auth §9.5 的一行、d5-content §7.3 的响应形状）。
//
// 响应是 JSON 的 {id, image_base64}，**不是 image/png 裸图**：前端 ProductCaptcha
// （web/src/routes/login.tsx）把 image_base64 直接塞进 <img src>，而表单提交时要带上 id
// ——设计 §9.5 的入参与 §7.2 的 verifyOrErr 都是「id + answer」成对校验，
// 只有一张图的话服务端没法把答案和某一道题对上。
const (
	// 10 次/小时：防脚本刷题（d2-auth §9.5 的额度表）。
	captchaIssueLimit  = 10
	captchaIssueWindow = time.Hour
	// 限流键前缀（d2-auth §9.5 与 d5-content §7.2 的键名逐字一致）。
	keyCaptchaIP = "auth:captcha:ip:"
)

// captchaIssue 是 GET /api/v1/captcha 的出参（契约真源）。
type captchaIssue struct {
	ID string `json:"id"`
	// ImageBase64 是可用的 data URI：前端不必知道它是 PNG，也就不会因为
	// 「裸 base64 还是 data URI」这个二选一而出现两套解析。
	ImageBase64 string `json:"image_base64"`
}

// IssueCaptcha 出一张题并限流。IP 由 handler 从 c.ClientIP() 取（与登录/注册一致）。
func (s *Service) IssueCaptcha(ctx context.Context, ip string) (*captchaIssue, error) {
	// 没装配（captcha.mode=off 时 app 层传 nil，这是正常状态）：不回 404、也不装一张假图。
	// 明说「现在没有这个能力」，出图失败的页面才会去查配置而不是查前端。
	if s.captcha == nil {
		return nil, ErrCaptchaUnavailable
	}
	if err := s.allow(ctx, keyCaptchaIP+ip, captchaIssueLimit, captchaIssueWindow); err != nil {
		return nil, err
	}
	id, png, err := s.captcha.Issue(ctx)
	if err != nil {
		s.log.Error("auth: 出验证码失败", "err", err.Error())
		return nil, ErrCaptchaUnavailable
	}
	return &captchaIssue{
		ID:          id,
		ImageBase64: "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	}, nil
}

// captcha GET /api/v1/captcha —— 游客可访问（白名单见设计 §9.2 的路由级测试）。
func (h *Handler) captcha(c *gin.Context) {
	out, err := h.svc.IssueCaptcha(c.Request.Context(), ClientIP(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// 题目不可缓存 —— 这是防重放的另一半（d5-content §7.3）。
	c.Header("Cache-Control", "no-store")
	httpx.OK(c, out)
}
