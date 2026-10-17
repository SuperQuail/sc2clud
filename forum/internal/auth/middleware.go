package auth

import (
	"errors"
	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	"forum/internal/platform/httpx"
)

// LoadPrincipal 是唯一的认证中间件：解 Cookie → 解析身份 → 挂到 context。
// 它**只做认证**：不判权限、不读 body、不写响应体（除了清掉失效的 Cookie）。
// 游客不是错误（设计 §6.4）。
func (s *Service) LoadPrincipal() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, err := c.Cookie(s.cfg.Site.CookieName)
		if err != nil || raw == "" {
			c.Next()
			return
		}
		p, err := s.Resolve(c.Request.Context(), raw)
		switch {
		case errors.Is(err, ErrSessionInvalid):
			// 过期 / 伪造 / 被封：清掉 Cookie 当游客。**不是** 401——读接口对游客也开放。
			s.ClearCookie(c)
			c.Next()
		case err != nil:
			// 真故障（库挂了）才中断；游客能读的页面不该因为身份解析失败而 500
			s.log.Error("auth: 解析会话失败", "err", err.Error())
			c.Next()
		default:
			c.Set(principalKey, p)
			httpx.SetUserID(c, p.UserID)
			s.TouchAsync(p.Digest)
			c.Next()
		}
	}
}

// RequireLogin 要求已登录：没有身份 → 401 common.unauthorized。
func (s *Service) RequireLogin() gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := principalFrom(c)
		if !ok || p.Status != StatusActive {
			httpx.Fail(c, unauthorized())
			return
		}
		c.Next()
	}
}

// RequireActivated 是**唯一的写闸门**（拍板 §9.12）：未激活 → 403 auth.not_activated。
// forum / media / message / reward 的写路由必须挂它；actor.EmailVerified **不挡任何功能**。
func (s *Service) RequireActivated() gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := principalFrom(c)
		if !ok || p.Status != StatusActive {
			httpx.Fail(c, unauthorized())
			return
		}
		if !p.Activated {
			httpx.Fail(c, ErrNotActivated)
			return
		}
		c.Next()
	}
}

// Perm 是全局权限点中间件（默认 AND，超管短路在最前）。
// **作用域权限（board.moderate）与资源归属不进中间件**：它们的入参是 board_id / author_id，
// 只有 service 层才有（设计 §8.4 第 ③ 条）。
func (s *Service) Perm(perms ...string) gin.HandlerFunc {
	return s.requirePerm(perms, false)
}

// PermAny 是任一命中即可。
func (s *Service) PermAny(perms ...string) gin.HandlerFunc {
	return s.requirePerm(perms, true)
}

// requirePerm 把 401 与 403 的分界实现一次（设计 §6.4）：
// 没有 Principal → 401；有 Principal 但缺权限 → 403。
func (s *Service) requirePerm(perms []string, any bool) gin.HandlerFunc {
	if len(perms) == 0 {
		// 路由写错了：Perm() 不带权限点等于把这条路由对所有人放行。启动即炸比线上静默放行好。
		panic("auth: Perm() 必须至少给一个权限点")
	}
	return func(c *gin.Context) {
		p, ok := principalFrom(c)
		if !ok || p.Status != StatusActive {
			httpx.Fail(c, unauthorized())
			return
		}
		if p.IsSuper {
			c.Next()
			return
		}
		pass := p.Perms.HasAll(perms...)
		if any {
			pass = p.Perms.HasAny(perms...)
		}
		if !pass {
			httpx.Fail(c, forbidden(perms[0]))
			return
		}
		c.Next()
	}
}

// actorFrom 是 handler 取身份的包内小工具：路由挂了 RequireLogin，取不到就是路由写错了。
func actorFrom(c *gin.Context) *authz.Actor {
	actor, _ := FromGin(c)
	return actor
}
