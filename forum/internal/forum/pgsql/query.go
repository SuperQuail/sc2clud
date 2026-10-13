package pgsql

import (
	"context"
	"database/sql"
)

// 本文件的四个函数是「拿任意 Querier 执行一条语句」的最小形状：
// 事务内的写与读都走它们（把 *ent.Tx 传进来即可），所以同一段 SQL 在
// 请求路径与事务里逐字相同。

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
