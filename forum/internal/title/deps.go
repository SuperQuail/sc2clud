package title

import (
	"context"
	"errors"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// ErrUserNotFound 是 UserLookup 的「查不到」约定值：由 app 注入的适配器把 user.ErrNotFound 映射过来，
// 本包不 import user 包（业务模块之间禁止互相 import）。service/handler 见到它 → 404。
var ErrUserNotFound = errors.New("title: 用户不存在")

// UserLookup 的实现方：*user.Service。handler 用它把 /users/{handle} 与 /admin/users/{id} 的
// 路径参数换成内部 id（service 的入参是 bigint，拍板 §5.6：自增 id 只在内网流动）。
type UserLookup interface {
	ByUsername(ctx context.Context, username string) (*UserBrief, error)
	ByPublicID(ctx context.Context, publicID string) (*UserBrief, error)
}

type UserBrief struct {
	ID       int64
	Handle   string
	Nickname string
}

// AuditSink 的实现方：*audit.Service。头衔的三个写操作必须留痕（提权是攻击者第一目标）。
// Entry 的形状与 audit 包一致；接线时 app 用一个 4 行的适配器把 audit.Entry 转过来
// （本包不 import audit：它还没写，且业务模块之间禁止互相 import）。
type AuditSink interface {
	Log(ctx context.Context, e AuditEntry) error
}

type AuditEntry struct {
	ActorID    int64
	Action     string
	TargetType string
	TargetID   string
	Detail     map[string]any
	IP         string
}

// 审计 action（与 audit 包的常量同名同值，一处定义在各自包里）。
const (
	ActionTitleGrant  = "title.grant"
	ActionTitleRevoke = "title.revoke"
	ActionTitleManage = "title.manage"
)

// ActorFromGin 由 app 注入 auth.FromGin（D2）：handler 取身份的唯一方式（拍板 §5.3）。
type ActorFromGin func(c *gin.Context) (*authz.Actor, bool)
