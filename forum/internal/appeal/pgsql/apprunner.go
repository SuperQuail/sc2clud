package pgsql

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/appeal"
)

// AppRunner 实现 appeal.TxRunner：开一个真事务并包成 AppTx。
// 池在这里，事务的形状也在这里 —— app 层只 new 一次（modules.go）。
type AppRunner struct{ pool *pgxpool.Pool }

func NewAppRunner(pool *pgxpool.Pool) *AppRunner { return &AppRunner{pool: pool} }

func (r *AppRunner) Begin(ctx context.Context) (appeal.TxHandle, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return NewAppTx(tx), nil
}
