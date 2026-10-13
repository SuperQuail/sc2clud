package forum

import (
	"context"
	"time"

	ent "forum/internal/ent"
	"forum/internal/platform/queue"
)

// 本域需要的外部能力，形状取到最小；业务模块之间禁止互相 import，这些接口由 app 层填。
// 依据：d3-forum §9.4（只有本域真正会调的方法，没有大接口、没有 HasPerm 转发）。
type (
	// UserLookup 由 internal/user.Service 实现。
	// GetAuthBrief 是「发帖审核豁免 + 等级门槛」两个字段的唯一来源：为此查两次 users 不值。
	UserLookup interface {
		GetAuthBrief(ctx context.Context, userID int64) (*UserAuthBrief, error)
		ByHandle(ctx context.Context, handle string) (*UserBrief, error)
	}

	// Renderer 由 platform/markdown 实现。plain 与 html 必须同源，
	// 否则会出现「正文里看得到、摘要里看不到」的字符（§9.4 末段）。
	Renderer interface {
		Render(md string) (html string, plain string)
	}

	// Queue 由 platform/queue 实现。事务内的任务必须走 EnqueueTx（拍板 §5.4）：
	// 事务回滚则任务不存在。
	Queue interface {
		EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error
	}

	// Counter 由 platform/counter.Buffer 实现：浏览量、转链计数都只进缓冲。
	Counter interface {
		Add(key string, delta int64)
		Get(key string) int64
	}

	// Limiter 由 platform/ratelimit 实现。转链端点 30/分钟/IP（§7.2）。
	Limiter interface {
		Allow(ctx context.Context, key string, limit int, window time.Duration) (ok bool, retryAfter time.Duration, err error)
	}
)

// UserAuthBrief 是发帖门槛与审核豁免要的两个字段（§9.4）。
type UserAuthBrief struct {
	ID      int64
	Trusted bool
	Level   int
	Status  string
}

// UserBrief 是列表卡片上的作者三字段 + 主页地址。
type UserBrief struct {
	ID          int64
	PublicID    string
	Handle      string
	Nickname    string
	AvatarHash  string
	AvatarSmall string
	Status      string
}

// Deps 是本域的全部外部依赖。app 层组装；测试里传假实现。
type Deps struct {
	Users   UserLookup
	Render  Renderer
	Queue   Queue
	Counter Counter
	Limit   Limiter
}
