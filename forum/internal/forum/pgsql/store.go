// Package pgsql 是本域**唯一**的原生 SQL 落点（d3-forum §9.1）。
// service 不内联 SQL，handler 不碰数据库。
//
// 为什么用 ent 的 ExecContext / QueryContext 而不是 pgxpool：
//   - 事务的唯一入口是 platform/db.WithTx，它给的是 *ent.Tx；要让「读」和「事务内的读」是同一套代码，
//     两者必须共有一个接口——ent 的 *Client 与 *Tx 都从内嵌的 config 上提升出
//     ExecContext/QueryContext（client.go 末尾那两个方法，由 --feature sql/execquery 打开）；
//   - pgxpool 拿不到同一个事务（它没有 ExecContext，pgx.Tx 也不是 sql 的执行器），
//     混用会让「事务里那次查询到底看的是哪个快照」变成一个说不清的问题。
//
// 代价说清楚：database/sql 的 *sql.Rows 用 driver.Value 传递列值，所以
//   - uuid → string（自己 Parse）；
//   - uuid[] → Postgres 的数组字面量文本 {a,b}（见 uuidArray 的解析）；
//   - timestamptz → time.Time（pgx 的 stdlib 驱动给的是 UTC 的 time.Time）。
package pgsql

import (
	"context"
	"database/sql"
	"time"

	ent "forum/internal/ent"
)

// Querier 是 *ent.Client 与 *ent.Tx 共有的最小接口。
// 只写这两个方法：本包需要的就是「发一条语句」与「发一条查询」。
type Querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

var (
	_ Querier = (*ent.Client)(nil)
	_ Querier = (*ent.Tx)(nil)
)

// Store 是本域的全部 SQL。读走 q（请求路径上是 *ent.Client），
// 写显式接收 *ent.Tx —— 事务边界在 service 的 db.WithTx 里，不在本包。
type Store struct{ q Querier }

func NewStore(q Querier) *Store { return &Store{q: q} }

// ErrNoRows 是本包对「查不到」的唯一表达，service 用它换业务错误码。
var ErrNoRows = sql.ErrNoRows

// exec 与 query 共用同一个 Querier：事务内的写也走这里（tx 传进来即可）。
func exec(ctx context.Context, q Querier, sql string, args ...any) error {
	_, err := q.ExecContext(ctx, sql, args...)
	return err
}

func rowsAffected(ctx context.Context, q Querier, sql string, args ...any) (int64, error) {
	res, err := q.ExecContext(ctx, sql, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// scanNullString 把可空文本列扫成 *string。
func scanNullString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func scanNullTime(v sql.NullTime) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time.UTC()
	return &t
}

func scanNullInt64(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}

// uuidArray 解析 Postgres 的 uuid[] 文本（{a,b}）。
// 只处理 uuid 这一种元素：uuid 的字符集是 [0-9a-f-]，不含引号、逗号、反斜杠与空格，
// 所以不需要通用的数组解析器（那种东西是本项目里没人会读的 60 行）。
func uuidArray(s string) []string {
	if len(s) < 2 || s[0] != '{' || s[len(s)-1] != '}' {
		return nil
	}
	body := s[1 : len(s)-1]
	if body == "" {
		return nil
	}
	out := make([]string, 0, 4)
	start := 0
	for i := 0; i <= len(body); i++ {
		if i == len(body) || body[i] == ',' {
			if i > start {
				out = append(out, body[start:i])
			}
			start = i + 1
		}
	}
	return out
}

// encodeUUIDArray 把 []string 拼成 Postgres 的 uuid[] 字面量参数。
// 参数用 $n::uuid[]，元素同样只有 [0-9a-f-]，所以拼接是安全的（值来自我们自己的数组，不是用户输入）。
func encodeUUIDArray(ids []string) string {
	if len(ids) == 0 {
		return "{}"
	}
	b := make([]byte, 0, len(ids)*37+2)
	b = append(b, '{')
	for i, id := range ids {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, id...)
	}
	return string(append(b, '}'))
}
