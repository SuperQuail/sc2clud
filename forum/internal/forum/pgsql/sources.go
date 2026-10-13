package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// SourceRow 是下载源的一行（§3.7 Q7c）。
type SourceRow struct {
	ID             int64
	PublicID       string
	TopicID        int64
	TopicPublicID  string // GoPath 由它拼出来（前端拿到的就是那个 302 地址）
	Provider       string
	Label          string
	URL            string
	ExtractionCode *string
	SizeText       string
	Upkeep         string
	GoCount        int64
	VerifiedAt     *time.Time
	Sort           int
}

const sourceColumns = `s.id, s.public_id, s.topic_id, t.public_id, s.provider, s.label, s.url, s.extraction_code,
       s.size_text, s.upkeep, s.go_count, s.verified_at, s.sort`

func scanSource(rows *sql.Rows, r *SourceRow) error {
	return rows.Scan(&r.ID, &r.PublicID, &r.TopicID, &r.TopicPublicID, &r.Provider, &r.Label, &r.URL, &r.ExtractionCode,
		&r.SizeText, &r.Upkeep, &r.GoCount, &r.VerifiedAt, &r.Sort)
}

// Sources 是详情里的下载源列表（§3.7 Q7c，走 idx_topic_sources_topic）。
// extraction_code 无条件返回：它是分享口令不是密码，而转链端点本来就是给游客点的——
// 想不公开它就不要填。
func (s *Store) Sources(ctx context.Context, topicID int64) ([]SourceRow, error) {
	var out []SourceRow
	// JOIN topics 只为拿 t.public_id（GoPath 要用它拼「302 地址」）。
	err := s.query(ctx, "SELECT "+sourceColumns+" FROM topic_sources s JOIN topics t ON t.id = s.topic_id"+
		" WHERE s.topic_id = $1 ORDER BY s.sort, s.id",
		[]any{topicID}, func(rows *sql.Rows) error {
			var r SourceRow
			if err := scanSource(rows, &r); err != nil {
				return err
			}
			out = append(out, r)
			return nil
		})
	return out, err
}

// SourceRef 是转链端点的目标：只取 url 与它所属主题的可见性（§7.2）。
// source 与 topic 是否匹配由 JOIN 条件本身回答，不再做二次校验。
func (s *Store) SourceRef(ctx context.Context, topicPublicID, sourcePublicID string) (*SourceRow, error) {
	var r SourceRow
	err := s.queryOne(ctx, `
SELECT s.id, s.public_id, s.topic_id, s.provider, s.label, s.url, s.extraction_code,
       s.size_text, s.upkeep, s.go_count, s.verified_at, s.sort
  FROM topic_sources s
  JOIN topics t ON t.id = s.topic_id
 WHERE s.public_id = $1 AND t.public_id = $2
   AND t.visibility = 'normal' AND t.review_state = 'approved'`,
		[]any{sourcePublicID, topicPublicID}, func(rows *sql.Rows) error {
			return scanSource(rows, &r)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// SourceRefByPublicID 是写路径（改 / 删 / 确认有效）取行：连主题的作者与 kind 一起拿，
// 归属判定留给 service（有 topic.edit.any 的人可以改别人的）。
func (s *Store) SourceRefByPublicID(ctx context.Context, publicID string) (SourceRow, int64, string, error) {
	var r SourceRow
	var authorID int64
	var kind string
	err := s.queryOne(ctx, `
SELECT ` + sourceColumns + `, t.author_id, t.kind
  FROM topic_sources s JOIN topics t ON t.id = s.topic_id
 WHERE s.public_id = $1`,
		[]any{publicID}, func(rows *sql.Rows) error {
			if err := scanSource(rows, &r); err != nil {
				return err
			}
			return rows.Scan(&authorID, &kind)
		})
	if err != nil {
		return SourceRow{}, 0, "", err
	}
	return r, authorID, kind, nil
}

// SourceByTopic 按 (topic public_id, source public_id) 取一条：PATCH 用它，
// 「这条源属不属于这个主题」由 WHERE 直接回答。
func (s *Store) SourceByTopic(ctx context.Context, topicPublicID, sourcePublicID string) (*SourceRow, error) {
	var r SourceRow
	err := s.queryOne(ctx, `
SELECT ` + sourceColumns + `
  FROM topic_sources s JOIN topics t ON t.id = s.topic_id
 WHERE s.public_id = $1 AND t.public_id = $2`,
		[]any{sourcePublicID, topicPublicID}, func(rows *sql.Rows) error {
			return scanSource(rows, &r)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// CountSources 是「每帖 ≤ 20 条」的门槛。
func (s *Store) CountSources(ctx context.Context, topicID int64) (int, error) {
	var n int
	err := s.queryOne(ctx, "SELECT count(*) FROM topic_sources WHERE topic_id = $1", []any{topicID},
		func(rows *sql.Rows) error { return rows.Scan(&n) })
	return n, err
}

// InsertSource 分配 sort 并插入（§7.3）。**不需要 FOR UPDATE**：sort 只影响显示顺序，
// 并发两条拿到同一个值也不会让任何东西坏掉（(topic_id, sort, id) 里 id 兜底）。
func InsertSource(ctx context.Context, tx Querier, topicID int64, in SourceInput, now time.Time) (int64, error) {
	var id int64
	err := queryOneQ(ctx, tx, `
INSERT INTO topic_sources (topic_id, provider, label, url, extraction_code, size_text, upkeep, sort, created_at)
SELECT $1, $2, $3, $4, $5, $6, 'active',
       COALESCE((SELECT max(sort) FROM topic_sources WHERE topic_id = $1), 0) + 1, $7
RETURNING id`,
		[]any{topicID, in.Provider, in.Label, in.URL, in.ExtractionCode, in.SizeText, now.UTC()},
		func(rows *sql.Rows) error { return rows.Scan(&id) })
	return id, err
}

// SourceInput 是本包用的入参形状（与 forum.SourceInput 字段一致，避免跨包循环引用）。
type SourceInput struct {
	Provider       string
	Label          string
	URL            string
	ExtractionCode *string
	SizeText       string
}

// UpdateSource 改一条源。**改 url 时 verified_at 不动**：
// 「我确认它还有效」是一个显式动作（verify 端点），不该被改错别字顺带刷掉（§7.3）。
func UpdateSource(ctx context.Context, tx Querier, sourceID int64, in SourceInput) error {
	return exec(ctx, tx, `
UPDATE topic_sources
   SET provider = $2, label = $3, url = $4, extraction_code = $5, size_text = $6
 WHERE id = $1`,
		sourceID, in.Provider, in.Label, in.URL, in.ExtractionCode, in.SizeText)
}

// VerifySource 是「我确认它还有效」：verified_at 与 upkeep 一起变——
// 点这个按钮就是在说「它还能下、我还在维护」（§7.3）。
func VerifySource(ctx context.Context, tx Querier, sourceID int64, now time.Time) error {
	return exec(ctx, tx, "UPDATE topic_sources SET verified_at = $2, upkeep = 'active' WHERE id = $1", sourceID, now.UTC())
}

// ArchiveSource 是归档：**不删行**（删了就丢掉了「这里曾经有过一个源」的信息，
// 而 issue 里可能正讨论它）。
func ArchiveSource(ctx context.Context, tx Querier, sourceID int64) error {
	return exec(ctx, tx, "UPDATE topic_sources SET upkeep = 'archived' WHERE id = $1", sourceID)
}

// DeleteSource 是真删：与归档的区别是「填错了、重复了才删」（§7.3）。
func DeleteSource(ctx context.Context, tx Querier, sourceID int64) error {
	return exec(ctx, tx, "DELETE FROM topic_sources WHERE id = $1", sourceID)
}

// DeleteSourcesOfTopic 用在「resource → 非 resource」的 kind 变更上：
// 否则会留下挂错地方的下载源（§4.5）。
func DeleteSourcesOfTopic(ctx context.Context, tx Querier, topicID int64) error {
	return exec(ctx, tx, "DELETE FROM topic_sources WHERE topic_id = $1", topicID)
}

// SourceByID 按 (topic_id, id) 取一条：新增之后回读卡片用。
func (s *Store) SourceByID(ctx context.Context, topicID, sourceID int64) (*SourceRow, error) {
	var r SourceRow
	err := s.queryOne(ctx, "SELECT "+sourceColumns+" FROM topic_sources s JOIN topics t ON t.id = s.topic_id"+
		" WHERE s.topic_id = $1 AND s.id = $2", []any{topicID, sourceID}, func(rows *sql.Rows) error {
		return scanSource(rows, &r)
	})
	if err != nil {
		return nil, err
	}
	return &r, nil
}
