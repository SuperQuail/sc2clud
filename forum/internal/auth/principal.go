package auth

import (
	"errors"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/auth/pgsql"
	"forum/internal/authz"
)

// ErrSessionInvalid 是「这个 token 不是有效会话」：过期、伪造、用户被封。
// 它**不是**错误响应——解析路径把它当游客处理并清掉 Cookie（设计 §6.2）。
var ErrSessionInvalid = errors.New("auth: 会话无效")

// ctxKey 是私有类型做 key：别的包无法用字符串 key 撞车，也无法伪造身份。
type ctxKey struct{}

// Principal 是一次请求的身份全集。它比 authz.Actor 多带会话自己的东西
// （摘要、csrf、过期时刻）——那些只在 auth 内部用，不进判定。
type Principal struct {
	UserID        int64
	PublicID      string
	Nickname      string
	Digest        []byte // sha256(原始 token)：登出当前设备与缓存失效用
	SessionID     int64
	CSRF          string
	EmailVerified bool
	Activated     bool
	Status        string
	AvatarHash    string
	AvatarSmall   string
	RoleID        int64
	RoleKey       string
	RoleName      string
	RoleBadge     string
	IsSuper       bool
	Perms         authz.Set
	BoardIDs      []int64
	Extra         []pgsql.ExtraPerm
	ExpiresAt     time.Time
}

// Actor 把 Principal 投影成判定需要的形状（拍板 §5.3：service 方法显式收 *authz.Actor）。
// Perms 共享同一个 Set，它是只读的。
func (p *Principal) Actor() *authz.Actor {
	return &authz.Actor{
		UserID:        p.UserID,
		PublicID:      p.PublicID,
		Perms:         p.Perms,
		BoardIDs:      p.BoardIDs,
		RoleID:        p.RoleID,
		RoleKey:       p.RoleKey,
		RoleName:      p.RoleName,
		RoleBadge:     p.RoleBadge,
		IsSuper:       p.IsSuper,
		EmailVerified: p.EmailVerified,
		Activated:     p.Activated,
		Status:        p.Status,
	}
}

const principalKey = "auth.principal"

// FromGin 是**所有模块取身份的唯一方式**（禁用 ctx.Value 到处捞）。
// 游客返回 (nil, false)。路由挂了 RequireLogin 时第二个返回值一定是 true——
// 拿不到就是路由写错了，那是路由级测试要发现的东西，不是运行时要兜的分支（拍板 §0）。
func FromGin(c *gin.Context) (*authz.Actor, bool) {
	v, ok := c.Get(principalKey)
	if !ok {
		return nil, false
	}
	p, ok := v.(*Principal)
	if !ok {
		return nil, false
	}
	return p.Actor(), true
}

// principalFrom 是包内版本：handler 与中间件要摘要 / csrf 时用它。
func principalFrom(c *gin.Context) (*Principal, bool) {
	v, ok := c.Get(principalKey)
	if !ok {
		return nil, false
	}
	p, ok := v.(*Principal)
	return p, ok
}

// ClientIP 把 c.ClientIP() 变成字符串交给 service。gin 已经把可信代理解析过了。
func ClientIP(c *gin.Context) string { return c.ClientIP() }

// parseInt64 解析游标里的自增 id（游标是不透明串，里面放自增 id 不违反拍板 §5.6）。
func parseInt64(s string) (int64, error) {
	return strconv.ParseInt(s, 10, 64)
}
