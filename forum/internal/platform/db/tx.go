package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"entgo.io/ent"
)

// WithTx 是事务的唯一入口。panic 与 error 都会回滚。
// 嵌套事务不支持，也不模拟 savepoint：调用链只允许最外层开事务（d1 §2.2）。
func WithTx(ctx context.Context, c *ent.Client, fn func(tx *ent.Tx) error) error {
	tx, err := c.Tx(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
	}()
	if err := fn(tx); err != nil {
		if rerr := tx.Rollback(); rerr != nil && !errors.Is(rerr, sql.ErrTxDone) {
			return fmt.Errorf("rollback: %w (after: %v)", rerr, err)
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}
