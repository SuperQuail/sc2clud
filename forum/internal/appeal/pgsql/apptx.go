package pgsql

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// AppTx 实现 appeal.TxHandle：app 层把它交给本域的 service，
// service 通过 appeal.WithTx 放进 context，Store 再从这里取出真正的执行器。
//
// 为什么放在本包：**这是本域 SQL 的唯一落点**，事务该怎么跑属于本域的知识；
// app 层只负责「拿一个 pgx 事务、交给 appeal」，不需要认识 executor 这三个方法。
type AppTx struct{ tx pgx.Tx }

func NewAppTx(tx pgx.Tx) *AppTx { return &AppTx{tx: tx} }

func (t *AppTx) Commit(ctx context.Context) error   { return t.tx.Commit(ctx) }
func (t *AppTx) Rollback(ctx context.Context) error { return t.tx.Rollback(ctx) }
func (t *AppTx) Executor() any                      { return t.tx }
