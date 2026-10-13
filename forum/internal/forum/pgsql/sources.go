package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// SourceRow 是下载源的一行（d3-forum §3.7 Q7c）。
// TopicPublicID 是它所属主题的 public_id：GoPath（302 地址）由它拼出来。
type SourceRow struct {
	ID             int64
	PublicID       string
	TopicID        int64
	TopicPublicID  string
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

var sourceColumns = sqlJoin(
	"s.id, s.public_id, s.topic_id, t.public_id, s.provider, s.label, s.url, s.extraction_code,",
	"s.size_text, s.upkeep, s.go_count, s.verified_at, s.sort",
)

const sourceFrom = " FROM topic_sources s JOIN topics t ON t.id = s.topic_id"

func scanSource(rows *sql.Rows, r *SourceRow) error {
	return rows.Scan(&r.ID, &r.PublicID, &r.TopicID, &r.TopicPublicID, &r.Provider, &r.Label, &r.URL,
		&r.ExtractionCode, &r.SizeText, &r.Upkeep, &r.GoCount, &r.VerifiedAt, &r.Sort)
}

// Sources 是详情里的下载源列表（§3.7 Q7c，走 idx_topic_sources_topic）。
// extraction_code 无条件返回：它是分享口令不是密码，而转链端点本来就是给游客点的。
func (s *Store) Sources(ctx context.Context, topicID int64) ([]SourceRow, error) {
	var out []SourceRow
	err := s.query(ctx, "SELECT "+sourceColumns+sourceFrom+" WHERE s.topic_id = $1::bigint ORDER BY s.sort, s.id",
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

// SourceRef 是转链端点的目标（§7.2）：source 与 topic 是否匹配由 JOIN 条件本身回答，
// 不再做二次校验。主题不可见时这一行查不出来（对外是 404）。
func (s *Store) SourceRef(ctx context.Context, topicPublicID, sourcePublicID string) (*SourceRow, error) {
	var r SourceRow
	err := s.queryOne(ctx, "SELECT "+sourceColumns+sourceFrom+
		" WHERE s.public_id = $1::uuid AND t.public_id = $2::uuid" +
		" AND t.visibility = 'normal' AND t.review_state = 'approved'",
		[]any{sourcePublicID, topicPublicID}, func(rows *sql.Rows) error {
			return scanSource(rows, &r)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// SourceRefByPublicID 是写路径（删 / 确认有效）取行：连主题的作者与 kind 一起拿，
// 归属判定留给 service（有 delete.any 的人可以改别人的）。
func (s *Store) SourceRefByPublicID(ctx context.Context, publicID string) (SourceRow, int64, string, error) {
	var r SourceRow
	var authorID int64
	var kind string
	err := s.queryOne(ctx, sqlJoin(
		"SELECT "+sourceColumns+", t.author_id, t.kind"+sourceFrom,
		" WHERE s.public_id = $1::uuid",
	), []any{publicID}, func(rows *sql.Rows) error {
		targets := append(sourceScanTargets(&r), &authorID, &kind)
		return rows.Scan(targets...)
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
	err := s.queryOne(ctx, "SELECT "+sourceColumns+sourceFrom+
		" WHERE s.public_id = $1::uuid AND t.public_id = $2::uuid",
		[]any{sourcePublicID, topicPublicID}, func(rows *sql.Rows) error {
			return scanSource(rows, &r)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// SourceByID 按 (topic_id, id) 取一条：新增之后回读卡片用。
func (s *Store) SourceByID(ctx context.Context, topicID, sourceID int64) (*SourceRow, error) {
	var r SourceRow
	err := s.queryOne(ctx, "SELECT "+sourceColumns+sourceFrom+
		" WHERE s.topic_id = $1::bigint AND s.id = $2::bigint",
		[]any{topicID, sourceID}, func(rows *sql.Rows) error {
			return scanSource(rows, &r)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// sourceScanTargets 是 scanSource 的扫描目标，单独拿一份给「再多扫两列」的调用方用。
func sourceScanTargets(r *SourceRow) []any {
	return []any{&r.ID, &r.PublicID, &r.TopicID, &r.TopicPublicID, &r.Provider, &r.Label, &r.URL,
		&r.ExtractionCode, &r.SizeText, &r.Upkeep, &r.GoCount, &r.VerifiedAt, &r.Sort}
}

// CountSources 是「每帖 <= 20 条」的门槛。
func (s *Store) CountSources(ctx context.Context, topicID int64) (int, error) {
	var n int
	err := s.queryOne(ctx, "SELECT count(*) FROM topic_sources WHERE topic_id = $1::bigint", []any{topicID},
		func(rows *sql.Rows) error { return rows.Scan(&n) })
	return n, err
}

// SourceInput 是本包用的入参形状（与 forum.SourceInput 字段一致，避免跨包循环引用）。
type SourceInput struct {
	Provider       string
	Label          string
	URL            string
	ExtractionCode *string
	SizeText       string
}

// InsertSource 分配 sort 并插入（§7.3）。**不需要 FOR UPDATE**：sort 只影响显示顺序，
// 并发两条拿到同一个值也不会让任何东西坏掉（(topic_id, sort, id) 里 id 兜底）。
func InsertSource(ctx context.Context, tx Querier, publicID string, topicID int64, in SourceInput, now time.Time) (int64, error) {
	var id int64
	err := queryOneQ(ctx, tx, sqlJoin(
		"INSERT INTO topic_sources (public_id, topic_id, provider, label, url, extraction_code, size_text, upkeep, sort, created_at)",
		"SELECT $1::uuid, $2::bigint, $3::varchar, $4::varchar, $5::text, $6::varchar, $7::varchar, 'active',",
		"       (COALESCE((SELECT max(sort) FROM topic_sources WHERE topic_id = $2::bigint), 0) + 1)::int, $8::timestamptz",
		"RETURNING id",
	), []any{publicID, topicID, in.Provider, in.Label, in.URL, in.ExtractionCode, in.SizeText, now.UTC()},
		func(rows *sql.Rows) error { return rows.Scan(&id) })
	return id, err
}

// UpdateSource 改一条源。**改 url 时 verified_at 不动**：
// 「我确认它还有效」是一个显式动作（verify 端点），不该被改错别字顺带刷掉（§7.3）。
func UpdateSource(ctx context.Context, tx Querier, sourceID int64, in SourceInput) error {
	return exec(ctx, tx, sqlJoin(
		"UPDATE topic_sources",
		"   SET provider = $2::varchar, label = $3::varchar, url = $4::text,",
		"       extraction_code = $5::varchar, size_text = $6::varchar",
		" WHERE id = $1::bigint",
	), sourceID, in.Provider, in.Label, in.URL, in.ExtractionCode, in.SizeText)
}

// VerifySource 是「我确认它还有效」：verified_at 与 upkeep 一起变（§7.3）。
func VerifySource(ctx context.Context, tx Querier, sourceID int64, now time.Time) error {
	return exec(ctx, tx,
		"UPDATE topic_sources SET verified_at = $2::timestamptz, upkeep = 'active' WHERE id = $1::bigint",
		sourceID, now.UTC())
}

// DeleteSource 是真删：与归档的区别是「填错了、重复了才删」（§7.3）。
func DeleteSource(ctx context.Context, tx Querier, sourceID int64) error {
	return exec(ctx, tx, "DELETE FROM topic_sources WHERE id = $1::bigint", sourceID)
}

// DeleteSourcesOfTopic 用在「resource -> 非 resource」的 kind 变更上：
// 否则会留下挂错地方的下载源（§4.5）。
func DeleteSourcesOfTopic(ctx context.Context, tx Querier, topicID int64) error {
	return exec(ctx, tx, "DELETE FROM topic_sources WHERE topic_id = $1::bigint", topicID)
}
