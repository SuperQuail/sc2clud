package media

import (
	"context"
	"database/sql"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
	ent "forum/internal/ent"
	"forum/internal/platform/queue"
)

// ActorFunc 由 app 层提供：从 gin 上下文取当前 Actor（接线时传 auth.FromGin）。
// 本模块不依赖 auth 包的任何名字（业务模块之间禁止互相 import）。
type ActorFunc func(c *gin.Context) (*authz.Actor, bool)

// Queue 只要事务内入队这一个能力。
type Queue interface {
	EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error
}

// sqlExec 是 media 的原生 SQL 需要的两个方法，ent 的 Client 与 Tx 都有。
// 头像列与 topic_images 的自然键是 hash / public_id，ent 表达不了，所以这几条 SQL 手写。
type sqlExec interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}
