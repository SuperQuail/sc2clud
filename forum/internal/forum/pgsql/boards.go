package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// BoardRow 是分区行 + 三个现算的统计（d3-forum §3.3 Q2e）。
type BoardRow struct {
	ID           int64
	Slug         string
	Name         string
	Description  string
	CoverHash    *string
	Status       string
	ACLEnabled   bool
	MinPostLevel int
	TopicCount   int64
	PostCount    int64
	TodayCount   int64
}

// 分区统计走 LATERAL：三个数都是 topics 上的索引现算，没有计数列（§1 的「为什么不做计数列」）。
// post_count 用 sum(reply_count) 而不是 count(posts)：后者要扫 posts 在分区里的全部行。
const boardSelect = `
SELECT b.id, b.slug, b.name, b.description, b.cover_hash, b.status,
       b.acl_enabled, b.min_post_level,
       live.topic_count, live.post_count, live.today_count
  FROM boards b
  LEFT JOIN LATERAL (
    SELECT count(*)                                   AS topic_count,
           coalesce(sum(t.reply_count), 0)            AS post_count,
           count(*) FILTER (WHERE t.created_at >= $1) AS today_count
      FROM topics t
     WHERE t.board_id = b.id AND t.visibility = 'normal' AND t.review_state = 'approved'
  ) live ON true
 WHERE b.status = 'active'
   AND ($2::bigint IS NULL OR b.id = $2)
   AND ($3::text IS NULL OR b.slug = $3)
 ORDER BY b.sort, b.id`

// todayStart 是「今日零点」，由 service 按站点时区算好再传：
// 在 SQL 里用 now() + date_trunc 就是第二处时区实现（§3.3 Q2e 的注）。
func (s *Store) Boards(ctx context.Context, todayStart time.Time, id *int64, slug *string) ([]BoardRow, error) {
	var out []BoardRow
	err := s.query(ctx, boardSelect, []any{todayStart.UTC(), id, slug}, func(rows *sql.Rows) error {
		var b BoardRow
		var cover sql.NullString
		if err := rows.Scan(&b.ID, &b.Slug, &b.Name, &b.Description, &cover, &b.Status,
			&b.ACLEnabled, &b.MinPostLevel, &b.TopicCount, &b.PostCount, &b.TodayCount); err != nil {
			return err
		}
		b.CoverHash = scanNullString(cover)
		out = append(out, b)
		return nil
	})
	return out, err
}

// BoardBySlug 是详情页那一行（含归档分区：归档分区的读是允许的，只是不能发帖）。
func (s *Store) BoardBySlug(ctx context.Context, slug string, todayStart time.Time) (*BoardRow, error) {
	var found *BoardRow
	err := s.query(ctx, boardSelect, []any{todayStart.UTC(), nil, slug}, func(rows *sql.Rows) error {
		var b BoardRow
		var cover sql.NullString
		if err := rows.Scan(&b.ID, &b.Slug, &b.Name, &b.Description, &cover, &b.Status,
			&b.ACLEnabled, &b.MinPostLevel, &b.TopicCount, &b.PostCount, &b.TodayCount); err != nil {
			return err
		}
		b.CoverHash = scanNullString(cover)
		found = &b
		return nil
	})
	if err != nil {
		return nil, err
	}
	if found == nil {
		return nil, ErrNoRows
	}
	return found, nil
}

// BoardIDBySlug 给「按 slug 发主题」用：先解 id，再进事务。
// status 一并返回：归档分区不能发帖。
func (s *Store) BoardIDBySlug(ctx context.Context, slug string) (int64, string, error) {
	var id int64
	var status string
	err := s.queryOne(ctx, "SELECT id, status FROM boards WHERE slug = $1", []any{slug}, func(rows *sql.Rows) error {
		return rows.Scan(&id, &status)
	})
	return id, status, err
}
