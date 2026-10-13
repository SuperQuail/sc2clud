package notify

import (
	"context"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// NoticeSettings 读 user_notice_settings。实现方：*user.Service。
//
// 接口在使用方定义，app 层注入（后端方案 §4.2 第 3 条）：user 包不需要知道 notify 存在。
type NoticeSettings interface {
	Get(ctx context.Context, userID int64) (*NoticeSetting, error)
}

// NoticeSetting 是「要不要发这条通知」需要的四件事（d4 §4.1 的判定）。
type NoticeSetting struct {
	Alert        bool   // 「消息提醒」总开关：关掉则任何通知都不产生
	ReplyScope   string // all / none
	MentionScope string // all / none
	LikeAlert    bool
}

// ActorFromGin 由 app 注入 auth.FromGin（D2）：handler 取身份的唯一方式（拍板 §5.3）。
// 类型与 auth.FromGin 完全相同，接线时直接赋值。
type ActorFromGin func(c *gin.Context) (*authz.Actor, bool)
