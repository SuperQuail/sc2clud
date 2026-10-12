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

// SelfCheck 返回所有自检失败的行（空 = 通过）。每条是给人看的一行。
func SelfCheck(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, foreignKeyWithoutIndexSQL)
	if err != nil {
		return nil, fmt.Errorf("db: foreign key index check: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var tbl, fk string
		if err := rows.Scan(&tbl, &fk); err != nil {
			return nil, fmt.Errorf("db: scan: %w", err)
		}
		out = append(out, fmt.Sprintf("外键 %s.%s 上没有可用索引（RI 查找会全表扫）", tbl, fk))
	}
	return out, rows.Err()
}
