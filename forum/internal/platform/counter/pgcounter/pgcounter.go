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

	updateSourceGoSQL = `
UPDATE topic_sources AS s SET go_count = s.go_count + v.d
  FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS d) AS v
 WHERE s.id = v.id
`
)

// writers 是 counter.Kind 的 kind → 那条写回语句。**两边必须一一对应**：
// counter 认识一个 kind 而这里没有对应语句 = 那个键的增量静默丢掉
// （Flush 不报错，只是没人接），比整批失败更难发现。
// 依据：缺陷处理总纲 §7 —— 「认得」与「落了」是两件事，所以
// counter/counter_test.go 的 TestEveryKindHasWriter 用 Kind 的产物反查这张表。
var writers = map[string]writer{
	"topic_view":     {updateTopicViewsSQL, true},
	"asset_download": {updateAssetDownloadsSQL, false},
	"source_go":      {updateSourceGoSQL, false},
}

// writer 是「某类键写哪张表」的定义。needsNow=true 的语句要第三个参数（写回时间）。
type writer struct {
	sql      string
	needsNow bool
}

// Flusher 是 counter.FlushFunc 的 PostgreSQL 实现。
type Flusher struct {
	pool  *pgxpool.Pool
	clock clock.Clock
}

func New(pool *pgxpool.Pool, c clock.Clock) *Flusher {
	return &Flusher{pool: pool, clock: c}
}

// Flush 按 kind 把键分到各表，各写一条语句。任一条失败即整批失败（由 counter 放回缓冲重试）。
// flatten 把 map 摊成两个等长数组（SQL 用 unnest 并行展开它们）。
func flatten(m map[int64]int64) ([]int64, []int64) {
	if len(m) == 0 {
		return nil, nil
	}
	ids := make([]int64, 0, len(m))
	deltas := make([]int64, 0, len(m))
	for id, d := range m {
		ids, deltas = append(ids, id), append(deltas, d)
	}
	return ids, deltas
}

func (f *Flusher) Flush(ctx context.Context, keys []string, deltas []int64) error {
	// 先按 (kind, id) 合并：同一条 UPDATE 里若有重复 id，PG 只会更新该行一次（取第一个匹配），
	// 后面几笔会被静默丢掉。合并放在 Go 里，SQL 就始终是「一个 id 最多出现一次」。
	batches := make(map[string]map[int64]int64, len(writers))
	for i, k := range keys {
		kind, id, err := counter.Kind(k)
		if err != nil {
			return err
		}
		if _, ok := writers[kind]; !ok {
			// 认得的键却没有写回语句：报错而不是跳过——跳过就是静默丢增量。
			return fmt.Errorf("pgcounter: 计数类别 %q 没有写回语句（键 %q）", kind, k)
		}
		if batches[kind] == nil {
			batches[kind] = make(map[int64]int64)
		}
		batches[kind][id] += deltas[i]
	}
	now := f.clock.Now()
	// 按 writerKinds 的固定顺序写：同一批里多张表没有顺序依赖，但它让输出可复现
	// （map 的遍历顺序随机，报错时「哪条语句先炸」不该随机）。
	for _, kind := range writerKinds {
		ids, ds := flatten(batches[kind])
		if len(ids) == 0 {
			continue
		}
		w := writers[kind]
		args := []any{ids, ds}
		if w.needsNow {
			args = append(args, now)
		}
		if _, err := f.pool.Exec(ctx, w.sql, args...); err != nil {
			return fmt.Errorf("pgcounter: %s: %w", kind, err)
		}
	}
	return nil
}

// writerKinds 是 writers 的键的固定顺序（写回顺序要可复现）。
var writerKinds = []string{"topic_view", "asset_download", "source_go"}
