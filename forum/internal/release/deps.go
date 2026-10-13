package release

import (
	"context"
	"database/sql"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// ActorFunc 由 app 层提供：从 gin 上下文取当前 Actor（接线时传 auth.FromGin）。
type ActorFunc func(c *gin.Context) (*authz.Actor, bool)

// Counter 是 platform/counter.Buffer 的最小形状：请求路径上只加内存。
type Counter interface {
	Add(key string, delta int64)
}

// sqlExec 是本模块原生 SQL 需要的两个方法，ent 的 Client 与 Tx 都有。
// （*ent.Client 与 *ent.Tx 的 ExecContext / QueryContext 都带 ctx，见 internal/ent/tx.go。）
type sqlExec interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}
