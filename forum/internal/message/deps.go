package message

import (
	"context"
	"errors"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// ErrUserNotFound 是 UserLookup 的「查不到」约定值：由 app 注入的适配器把 user.ErrNotFound 映射过来，
// 本包不 import user 包（业务模块之间禁止互相 import）。service 见到它 → 404。
var ErrUserNotFound = errors.New("message: 用户不存在")

// UserLookup 的实现方：*user.Service。
type UserLookup interface {
	ByUsername(ctx context.Context, username string) (*UserBrief, error)
}

// UserBrief 是会话列表与会话头需要的对方资料。ID 是内部 id，不出 API（拍板 §5.6）。
type UserBrief struct {
	ID          int64  `json:"-"`
	Handle      string `json:"handle"`
	Nickname    string `json:"nickname"`
	Avatar      string `json:"avatar"` // /img/<hash>，空串 = 没有头像（前端回落默认头像）
	AvatarSmall string `json:"avatar_small"`
}

// BlockReader 的实现方：*forum.Service（blocks 在 forum 的 schema 里，d4 §4.9）。
type BlockReader interface {
	BlockedBetween(ctx context.Context, a, b int64) (aBlockedB, bBlockedA bool, err error)
}

// ActorFromGin 由 app 注入 auth.FromGin（D2）：handler 取身份的唯一方式（拍板 §5.3）。
type ActorFromGin func(c *gin.Context) (*authz.Actor, bool)
