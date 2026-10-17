// Package pgsql 是 search 的 PostgreSQL 实现。原生 SQL 只在本包与手写迁移里（开发必读 §1 硬规则 8）。
package pgsql

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode"

	"forum/internal/ent"
	"forum/internal/platform/search"
)

// Searcher 实现 search.Searcher 与 search.Indexer。
//
// 只依赖 *ent.Client：ent 的 Client / Tx 都暴露 ExecContext 与 QueryContext，
// 所以同一个类型既能用在请求路径（自动提交），也能用在事务里（NewTx，搜索任务用）。
type Searcher struct {
	db execQuery
}

// execQuery 是 ent.Client 与 ent.Tx 共有的最小接口。
type execQuery interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func New(db *ent.Client) *Searcher { return &Searcher{db: db} }

// NewTx 让索引写入与业务写在同一个事务里。
func NewTx(tx *ent.Tx) *Searcher { return &Searcher{db: tx} }

// exactSQL / looseSQL 是两条**完整**查询，没有任何可选的 SQL 片段拼接：
// 参数永远是占位符，用户输入永远不拼进 SQL（d5 §6.6）。
const exactSQL = `
SELECT t.id, t.public_id, t.title, ts_rank(s.tsv, plainto_tsquery('simple', $1)) AS rank
  FROM topic_search s
  JOIN topics t ON t.id = s.topic_id
 WHERE s.tsv @@ plainto_tsquery('simple', $1)
   AND t.visibility   = 'normal'
   AND t.review_state = 'approved'
   AND ($2::bigint IS NULL OR t.board_id = $2)
   AND ($3::real IS NULL OR (ts_rank(s.tsv, plainto_tsquery('simple', $1)), t.id) < ($3::real, $4::bigint))
 ORDER BY rank DESC, t.id DESC
 LIMIT $5`

const looseSQL = `
SELECT t.id, t.public_id, t.title, ts_rank(s.tsv, to_tsquery('simple', $1)) AS rank
  FROM topic_search s
  JOIN topics t ON t.id = s.topic_id
 WHERE s.tsv @@ to_tsquery('simple', $1)
   AND t.visibility   = 'normal'
   AND t.review_state = 'approved'
   AND ($2::bigint IS NULL OR t.board_id = $2)
   AND ($3::real IS NULL OR (ts_rank(s.tsv, to_tsquery('simple', $1)), t.id) < ($3::real, $4::bigint))
 ORDER BY rank DESC, t.id DESC
 LIMIT $5`

// SearchTopics 先跑 exact；**只有首页 0 行**才降级到 loose（拍板 §8.5）。
// 翻页（带游标）时必须把上一页的 tier 原样带回：档位对不上就从第一页重来，
// 宁可重复一页，也不给错序的结果（d5 §6.3）。
func (s *Searcher) SearchTopics(ctx context.Context, q search.Query) (search.Page, error) {
	rank, id := q.CursorRank, q.CursorID
	if q.Tier != "" && rank == nil {
		// 请求带档位却没带游标 = 「重新搜一次」：忽略档位，从第一页重算
		rank, id = nil, nil
	}
	first := rank == nil
	exact, err := s.run(ctx, search.TierExact, q, rank, id)
	if err != nil {
		return search.Page{}, err
	}
	if !first {
		// 翻页：档位由调用方带回（loose 的 rank 分布与 exact 不同，
		// 把 loose 的游标喂给 exact 就是错序结果）。档位对不上时游标作废，从第一页重来。
		if q.Tier == search.TierLoose {
			return s.run(ctx, search.TierLoose, q, rank, id)
		}
		if len(exact.Hits) > 0 {
			return exact, nil
		}
		return s.run(ctx, search.TierLoose, q, nil, nil)
	}
	if len(exact.Hits) > 0 { // 有精确结果就不要用 OR 去稀释它
		return exact, nil
	}
	return s.run(ctx, search.TierLoose, q, nil, nil)
}

func (s *Searcher) run(ctx context.Context, tier search.Tier, q search.Query, rank *float32, id *int64) (search.Page, error) {
	query, arg := exactSQL, q.Tokens
	if tier == search.TierLoose {
		query, arg = looseSQL, looseQuery(q.Tokens)
		if arg == "" {
			return search.Page{Hits: []search.Hit{}, Tier: tier}, nil
		}
	}
	rows, err := s.db.QueryContext(ctx, query, arg, q.BoardID, rank, id, q.Limit)
	if err != nil {
		return search.Page{}, fmt.Errorf("search: query %s: %w", tier, err)
	}
	defer rows.Close()

	page := search.Page{Hits: []search.Hit{}, Tier: tier}
	for rows.Next() {
		var h search.Hit
		if err := rows.Scan(&h.TopicID, &h.PublicID, &h.Title, &h.Rank); err != nil {
			return search.Page{}, fmt.Errorf("search: scan: %w", err)
		}
		page.Hits = append(page.Hits, h)
	}
	if err := rows.Err(); err != nil {
		return search.Page{}, fmt.Errorf("search: rows: %w", err)
	}
	// next_cursor 只在「这一页可能还有」时给（拍板 §5.1）
	if len(page.Hits) == q.Limit {
		last := page.Hits[len(page.Hits)-1]
		r := last.Rank
		i := last.TopicID
		page.NextCursorRank, page.NextCursorID = &r, &i
	}
	return page, nil
}

// looseQuery 用单字词素拼 to_tsquery 的 OR 串（"难|题"）。
//
// 拼的是**已经过 Tokenize 的词素**，不是用户输入；$1 仍然是参数占位符。
// 逐词素断言只含内容字符——不在白名单里的词素整档跳过（它本来也不可能是 Tokenize 的输出）。
func looseQuery(tokens string) string {
	var parts []string
	for _, tok := range strings.Fields(tokens) {
		runes := []rune(tok)
		if len(runes) != 1 {
			continue // 只要单字词素；bigram 拆开还是同一批单字，不需要第二个函数
		}
		if !unicode.IsLetter(runes[0]) && !unicode.IsDigit(runes[0]) {
			return "" // tsquery 的元字符（& | ! ( ) : * <）在这里被挡住
		}
		parts = append(parts, tok)
	}
	return strings.Join(parts, "|")
}

// UpsertTopic 幂等写入（d5 §6.8）：同一主题重放任意次结果逐字节相同。
func (s *Searcher) UpsertTopic(ctx context.Context, doc search.TopicDoc) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO topic_search (topic_id, title, body_text, tokens, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (topic_id) DO UPDATE
   SET title = EXCLUDED.title, body_text = EXCLUDED.body_text,
       tokens = EXCLUDED.tokens, updated_at = now()`,
		doc.TopicID, doc.Title, doc.BodyText, doc.Tokens)
	if err != nil {
		return fmt.Errorf("search: upsert topic %d: %w", doc.TopicID, err)
	}
	return nil
}

// DeleteTopic 幂等：行不存在时 0 行受影响，不是错误。
func (s *Searcher) DeleteTopic(ctx context.Context, topicID int64) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM topic_search WHERE topic_id = $1", topicID)
	if err != nil {
		return fmt.Errorf("search: delete topic %d: %w", topicID, err)
	}
	return nil
}
