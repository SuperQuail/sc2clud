package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// foreignKeyWithoutIndexSQL 是数据库文档 §12 第 1 条的检查：
// PG 不为外键自动建索引，漏了会在删父行时全表扫。
//
// 两个必须有的过滤（盲审核实过）：
//   - indisvalid：排除建失败的索引
//   - indpred IS NULL：排除部分索引——RI 查找用不了它，会被误判成「已覆盖」
//
// 注意：这条只保证「外键列上有可用索引」，复合主键的第二列不算已索引
// （bookmarks.topic_id、board_moderators.user_id、topic_images.topic_id 都是级联删除的真实路径）。
const foreignKeyWithoutIndexSQL = `
SELECT c.conrelid::regclass::text AS tbl, c.conname AS fk
  FROM pg_constraint c
 WHERE c.contype = 'f'
   AND NOT EXISTS (
     SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND i.indisvalid
        AND i.indpred IS NULL
        AND (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] @> c.conkey
   )
 ORDER BY 1, 2
`

// clientTokenWithoutUniqueIndexSQL 的由来（2026-10-13）：
//
// **写路径把幂等押在一条唯一索引上，而那条索引在迁移里被写成了普通索引。**
// `posts` 的 `CreatePost` 靠 23505 冲突回查既有行来实现「同一个 client_token 只建一次」；
// 索引不唯一 → 冲突永不发生 → 回查分支是死代码 → 重放会重复插入。
// 而当时的自检只查「外键有没有索引」，**没有任何检查看得见「设计承诺的索引是否存在」**，
// 所以它静静地错到有人重放请求才发现（实测 seed 跑两遍 posts 从 106 涨到 181）。
//
// 这条检查**不硬编码表名**：凡是有 client_token 列的表，都必须有一条 (author_id, client_token) 的
// **部分唯一索引** —— 以后新增这类表会自动被覆盖。
const clientTokenWithoutUniqueIndexSQL = `
SELECT c.table_name
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND c.column_name = 'client_token'
   AND NOT EXISTS (
     SELECT 1
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = c.table_name
        AND i.indisunique
        AND i.indpred IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = i.indrelid AND a.attname = 'client_token'
                       AND a.attnum = ANY (i.indkey))
        AND EXISTS (SELECT 1 FROM pg_attribute b
                     WHERE b.attrelid = i.indrelid AND b.attname = 'author_id'
                       AND b.attnum = ANY (i.indkey))
   )
 ORDER BY 1
`

// SelfCheck 返回所有自检失败的行（空 = 通过）。每条是给人看的一行。
func SelfCheck(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	var out []string

	rows, err := pool.Query(ctx, foreignKeyWithoutIndexSQL)
	if err != nil {
		return nil, fmt.Errorf("db: foreign key index check: %w", err)
	}
	for rows.Next() {
		var tbl, fk string
		if err := rows.Scan(&tbl, &fk); err != nil {
			rows.Close()
			return nil, fmt.Errorf("db: scan: %w", err)
		}
		out = append(out, fmt.Sprintf("外键 %s.%s 上没有可用索引（RI 查找会全表扫）", tbl, fk))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows2, err := pool.Query(ctx, clientTokenWithoutUniqueIndexSQL)
	if err != nil {
		return nil, fmt.Errorf("db: client token index check: %w", err)
	}
	for rows2.Next() {
		var tbl string
		if err := rows2.Scan(&tbl); err != nil {
			rows2.Close()
			return nil, fmt.Errorf("db: scan: %w", err)
		}
		out = append(out, fmt.Sprintf("%s.client_token 上没有**部分唯一索引** (author_id, client_token)：写路径的幂等靠它，缺了就会重复插入", tbl))
	}
	rows2.Close()
	return out, rows2.Err()
}
