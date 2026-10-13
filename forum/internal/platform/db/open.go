// Package db 打开唯一的连接池，并把它接到 ent 上。
// 依据：数据库文档 §7（参数写死）、d1-platform.md §2。
package db

import (
	"context"
	"fmt"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	ent "forum/internal/ent"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"forum/internal/config"
)

// Open 建池并立刻 Ping：启动即失败，别等到第一个请求。
// 返回的 pool 用来 ping、跑队列的原生 SQL 与看统计；ent.Client 走 ent 查询。
func Open(ctx context.Context, c config.DB) (*ent.Client, *pgxpool.Pool, error) {
	pc, err := pgxpool.ParseConfig(c.DSN)
	if err != nil {
		return nil, nil, fmt.Errorf("db: parse dsn: %w", err)
	}
	pc.MaxConns = c.MaxConns
	pc.MinConns = c.MinConns
	pc.MaxConnLifetime = c.MaxConnLifetime
	pc.MaxConnIdleTime = c.MaxConnIdleTime
	pc.ConnConfig.RuntimeParams["timezone"] = "UTC" // 会话级 UTC，不依赖服务端配置
	pc.ConnConfig.RuntimeParams["application_name"] = "forum"
	// 真正打死服务的是长事务与卡住的查询：三条超时都必须在会话上设死
	pc.ConnConfig.RuntimeParams["statement_timeout"] = c.StatementTimeout.String()
	pc.ConnConfig.RuntimeParams["lock_timeout"] = c.LockTimeout.String()
	pc.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = c.IdleTxTimeout.String()
	// 连接池上的准备语句不做无限缓存
	pc.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeDescribeExec

	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, nil, fmt.Errorf("db: new pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("db: ping: %w", err)
	}

	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))))
	return client, pool, nil
}

// 编译期断言 supabase：pgx 的错误类型在队列实现里用来判唯一冲突
var _ = pgx.ErrNoRows
