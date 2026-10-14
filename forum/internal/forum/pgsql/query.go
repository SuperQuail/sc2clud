package pgsql

import (
	"context"
	"database/sql"
)

// 本文件的四个函数是「拿任意 Querier 执行一条语句」的最小形状：
// 事务内的写与读都走它们（把 *ent.Tx 传进来即可），所以同一段 SQL 在
// 请求路径与事务里逐字相同。

// Row 只需要一个 Scan：*sql.Row 与 rowScanner 都满足它。
type Row interface {
	Scan(dest ...any) error
}

// QueryRow 是「只取一行」的入口。ent 只给 QueryContext，没有 QueryRowContext，
// 所以这里用 QueryContext 包一层 —— 否则每个调用点都要自己写一遍 rows.Next() 那五行。
// 返回值必须 .Scan() 一次，Scan 会关掉底层的 Rows。
func QueryRow(ctx context.Context, q Querier, sql string, args ...any) Row {
	rows, err := q.QueryContext(ctx, sql, args...)
	return rowScanner{rows: rows, err: err}
}

type rowScanner struct {
	rows *sql.Rows
	err  error
}

func (r rowScanner) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	defer r.rows.Close()
	if !r.rows.Next() {
		if err := r.rows.Err(); err != nil {
			return err
		}
		return ErrNoRows
	}
	return r.rows.Scan(dest...)
}

// queryQ 跑一条查询，把每一行交给 scan。
func queryQ(ctx context.Context, q Querier, sql string, args []any, scan func(*sql.Rows) error) error {
	rows, err := q.QueryContext(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// queryOneQ 是「预期 0 或 1 行」的查询（按主键 / 唯一键取一行）。
func queryOneQ(ctx context.Context, q Querier, sql string, args []any, scan func(*sql.Rows) error) error {
	rows, err := q.QueryContext(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return err
		}
		return ErrNoRows
	}
	return scan(rows)
}

func (s *Store) query(ctx context.Context, sql string, args []any, scan func(*sql.Rows) error) error {
	return queryQ(ctx, s.q, sql, args, scan)
}

func (s *Store) queryOne(ctx context.Context, sql string, args []any, scan func(*sql.Rows) error) error {
	return queryOneQ(ctx, s.q, sql, args, scan)
}

// sqlJoin 把多行 SQL 拼成一个字符串：每行都是独立的 Go 字符串字面量，
// 这样 SQL 里出现反引号或百分号都不会破坏源码（本项目踩过这个坑）。
func sqlJoin(lines ...string) string {
	out := ""
	for i, l := range lines {
		if i > 0 {
			out += "\n"
		}
		out += l
	}
	return out
}
