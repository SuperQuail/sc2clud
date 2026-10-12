package db

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/testsupport"
)

// withRawTx 与 WithTx 同形状的原生版本：事务语义来自 database/sql，与 ent 生成代码无关。
func withRawTx(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(ctx)
			panic(p)
		}
	}()
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

func countingPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, pool := testsupport.Pool(t)
	if _, err := pool.Exec(ctx, "CREATE TABLE tx_probe (id bigint PRIMARY KEY, note text NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	return ctx, pool
}

func assertCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, want int, msg string) {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM tx_probe").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != want {
		t.Fatalf("%s: 实际 %d 行，期望 %d", msg, n, want)
	}
}

func TestRollbackOnError(t *testing.T) {
	ctx, pool := countingPool(t)
	want := errors.New("业务失败")
	err := withRawTx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "INSERT INTO tx_probe (id, note) VALUES (1, 'a')"); err != nil {
			return err
		}
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("错误必须原样返回，实际 %v", err)
	}
	assertCount(t, ctx, pool, 0, "回滚后不该有数据")
}

func TestRollbackOnPanic(t *testing.T) {
	ctx, pool := countingPool(t)
	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("panic 必须继续向上传播")
			}
		}()
		_ = withRawTx(ctx, pool, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "INSERT INTO tx_probe (id, note) VALUES (2, 'b')"); err != nil {
				return err
			}
			panic("boom")
		})
	}()
	assertCount(t, ctx, pool, 0, "panic 之后必须回滚")
}

func TestCommitIsVisible(t *testing.T) {
	ctx, pool := countingPool(t)
	if err := withRawTx(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "INSERT INTO tx_probe (id, note) VALUES (3, 'c')")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	assertCount(t, ctx, pool, 1, "提交后必须有数据")
}
