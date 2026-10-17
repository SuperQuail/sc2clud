package reward

import (
	"context"

	ent "forum/internal/ent"
	"forum/internal/platform/queue"
)

// Queue 只要事务内入队这一个能力。
type Queue interface {
	EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error
}

// UserBasic 是本模块需要的最小用户画像；实现方是 internal/user。
type UserBasic struct {
	PublicID string
	Handle   string
	Nickname string
	Avatar   string // 头像小图 hash；空 = 前端用默认头像
	Status   string // active / banned / deleted
}

// UserLookup 由 app 层注入 internal/user 的实现（v2 §4.2 第 3 条：各自 deps.go 定小接口）。
type UserLookup interface {
	IDByHandle(ctx context.Context, handle string) (int64, error)
	Basic(ctx context.Context, userID int64) (UserBasic, error)
}

// Auditor 就是 platform/audit.Writer 的形状。本模块只认这个接口，不 import 那个包。
// 审计必须传 tx：业务行与审计行同事务，否则会出现「核验成功但审计丢失」。
type Auditor interface {
	Write(ctx context.Context, tx *ent.Tx, e AuditEntry) error
}

// AuditEntry 与 platform/audit.Entry 字段逐字对应，装配处可直接互相赋值。
type AuditEntry struct {
	ActorID    *int64
	Action     string
	TargetType string
	TargetID   string
	Detail     map[string]any
	IP         string
}

// Settings 是站点开关的只读视图，实现方是 internal/site。
// 本模块只读 donation.enabled 与 donation.notice_default。
type Settings interface {
	Setting(ctx context.Context, key string) string
}
