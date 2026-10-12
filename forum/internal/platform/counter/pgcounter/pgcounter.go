// Package pgcounter 是热点计数的写回实现：一条批量 UPDATE，不是每 key 一条。
// 原生 SQL 落在这里的理由与 platform/search/pgsql 相同：ent 表达不了 UPDATE ... FROM (VALUES ...)。
// 依据：d1-platform.md §7。
package pgcounter

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/platform/clock"
	"forum/internal/platform/counter"
)

// 一组计数写回一条语句：id 与 delta 用两个数组并行展开。
// 走的都是主键（WHERE x.id = v.id），所以是 N 次主键索引查找，不是全表扫。
const (
	updateTopicViewsSQL = `
UPDATE topics AS t SET view_count = t.view_count + v.d, updated_at = $3
  FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS d) AS v
 WHERE t.id = v.id
`

	updateAssetDownloadsSQL = `
UPDATE release_assets AS a SET download_count = a.download_count + v.d
  FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS d) AS v
 WHERE a.id = v.id
`
)

// Flusher 是 counter.FlushFunc 的 PostgreSQL 实现。
type Flusher struct {
	pool  *pgxpool.Pool
	clock clock.Clock
}

func New(pool *pgxpool.Pool, c clock.Clock) *Flusher {
	return &Flusher{pool: pool, clock: c}
}

// Flush 按前缀把键分到两张表，各写一条语句。任一条失败即整批失败（由 counter 放回缓冲重试）。
func (f *Flusher) Flush(ctx context.Context, keys []string, deltas []int64) error {
	topicIDs, topicDeltas := make([]int64, 0, len(keys)), make([]int64, 0, len(keys))
	assetIDs, assetDeltas := make([]int64, 0, len(keys)), make([]int64, 0, len(keys))
	for i, k := range keys {
		kind, id, err := counter.Kind(k)
		if err != nil {
			return err
		}
		switch kind {
		case "topic_view":
			topicIDs, topicDeltas = append(topicIDs, id), append(topicDeltas, deltas[i])
		case "asset_download":
			assetIDs, assetDeltas = append(assetIDs, id), append(assetDeltas, deltas[i])
		}
	}
	now := f.clock.Now()
	if len(topicIDs) > 0 {
		if _, err := f.pool.Exec(ctx, updateTopicViewsSQL, topicIDs, topicDeltas, now); err != nil {
			return fmt.Errorf("pgcounter: topic views: %w", err)
		}
	}
	if len(assetIDs) > 0 {
		if _, err := f.pool.Exec(ctx, updateAssetDownloadsSQL, assetIDs, assetDeltas); err != nil {
			return fmt.Errorf("pgcounter: asset downloads: %w", err)
		}
	}
	return nil
}
