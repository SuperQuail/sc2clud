package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// 人工审核队列（2026-10-14 补）。为什么必须有这一侧，见 forum/review_queue.go 的文件头。
// 本文件是它的全部 SQL：列表 + 取一行 + 判定 + 审计。

// reviewQueueColumns 是两个查询共用的列清单（各写一份必然漂移）。
// 作者三列照抄 topicColumns 的写法：avatar_hash 空 → default_avatar_hash，
// 否则作者头像会退回首字母占位（dto.go 的 UserBriefDTO 注释）。
const reviewQueueColumns = `t.id, t.public_id::text, t.title, t.kind, COALESCE(t.excerpt, ''),
       t.review_state, t.review_note, t.review_source,
       b.slug, b.name,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username),
       COALESCE(NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''),
       COALESCE(NULLIF(a.avatar_small_hash, ''), NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), a.status,
       t.created_at, t.updated_at`

const reviewQueueFrom = `
  FROM topics t
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = t.author_id`

// ReviewQueueRow 是队列的一行：一屏要能判断「这是什么、谁写的、AI 说了什么」。
type ReviewQueueRow struct {
	ID       int64
	PublicID string
	Title    string
	Kind     string
	Excerpt  string
	// ReviewNote 是**当前生效**的那条理由：AI 判的与人工写的都落在这一列，
	// 谁写的看 ReviewSource（ai / manual / trusted）。没有第三列可读 —— 别再造一个 ai_review_note。
	ReviewState  string
	ReviewNote   *string
	ReviewSource *string
	BoardSlug    string
	BoardName    string
	Author       UserRow
	CreatedAt    time.Time
	// UpdatedAt 是**内容的版本**：作者改正文会经 ResetTopicReview 把它推新。
	// 判定时必须把它带回来（$8），否则「审核员看到的」与「他批的」可以是两份不同的正文。
	UpdatedAt time.Time
}

// scanReviewQueueRow 是那一列清单的唯一扫描器。
func scanReviewQueueRow(rows *sql.Rows, r *ReviewQueueRow) error {
	var note, source, avatar, avatarSmall sql.NullString
	if err := rows.Scan(
		&r.ID, &r.PublicID, &r.Title, &r.Kind, &r.Excerpt,
		&r.ReviewState, &note, &source,
		&r.BoardSlug, &r.BoardName,
		&r.Author.ID, &r.Author.PublicID, &r.Author.Handle, &r.Author.Nickname,
		&avatar, &avatarSmall, &r.Author.Status,
		&r.CreatedAt, &r.UpdatedAt,
	); err != nil {
		return err
	}
	r.ReviewNote, r.ReviewSource = scanNullString(note), scanNullString(source)
	r.Author.AvatarHash = scanNullString(avatar)
	r.Author.AvatarSmall = scanNullString(avatarSmall)
	return nil
}

// ReviewQueue 吃 idx_topics_review_queue：部分索引
// (review_state, created_at DESC, id DESC) WHERE review_state <> 'approved'（0004）。
// 所以只允许查非 approved 的档 —— 查 approved 用不上这个索引，而「看已通过的」不是队列要做的事。
// 排序键 (created_at, id) 与索引逐字对齐；游标用 pageCursor 的哨兵，WHERE 里的行比较永远在。
func (s *Store) ReviewQueue(ctx context.Context, state, boardSlug, q string,
	cursorT time.Time, cursorID int64, limit int) ([]ReviewQueueRow, error) {
	out := make([]ReviewQueueRow, 0, limit)
	err := s.query(ctx, sqlJoin(
		"SELECT "+reviewQueueColumns+reviewQueueFrom,
		" WHERE t.visibility <> 'deleted'",
		"   AND ($1 = 'all' OR t.review_state = $1)",
		"   AND ($2 = '' OR b.slug = $2)",
		"   AND ($3 = '' OR t.title ILIKE '%' || $3 || '%'",
		"                OR a.username ILIKE '%' || $3 || '%'",
		"                OR COALESCE(a.nickname, '') ILIKE '%' || $3 || '%')",
		"   AND (t.created_at, t.id) < ($4, $5)",
		" ORDER BY t.created_at DESC, t.id DESC",
		" LIMIT $6",
	), []any{state, boardSlug, q, cursorT.UTC(), cursorID, limit},
		func(rows *sql.Rows) error {
			var r ReviewQueueRow
			if err := scanReviewQueueRow(rows, &r); err != nil {
				return err
			}
			out = append(out, r)
			return nil
		})
	return out, err
}

// ReviewQueueItem 按内部 id 取队列里的同一行：判定完要回执「更新后的那一条」，
// 而回执必须与列表逐字同形（否则前端要维护两种形状）。
func (s *Store) ReviewQueueItem(ctx context.Context, topicID int64) (*ReviewQueueRow, error) {
	var r ReviewQueueRow
	err := s.queryOne(ctx, "SELECT "+reviewQueueColumns+reviewQueueFrom+" WHERE t.id = $1",
		[]any{topicID}, func(rows *sql.Rows) error { return scanReviewQueueRow(rows, &r) })
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// SetTopicReview 是人工判定的唯一落点。返回受影响行数：0 = 没这条主题或已删（service 换 404）。
//
//   - review_source 一律写 'manual'：AI 任务见到 manual 直接返回（d7 §1 铁律：AI 绝不覆盖人工判定）；
//   - $3 传 nil 表示「通过且不写理由」——review_note 被清空，上一版的拒绝理由不该留着；
//   - reviewed_by/reviewed_at 是 notify:review 取「审核人是谁」的唯一来源（notify/tasks.go:126）。
func SetTopicReview(ctx context.Context, tx Querier, topicID int64, state string, note *string,
	reviewerID int64, unhide bool, expectState string, expectUpdatedAt *time.Time, now time.Time) (int, error) {
	n, err := rowsAffected(ctx, tx, sqlJoin(
		"UPDATE topics",
		"   SET review_state  = $2,",
		"       review_note   = $3,",
		"       review_source = 'manual',",
		"       reviewed_by   = $4,",
		"       reviewed_at   = $5,",
		// $6 放行时把 visibility 还原成 normal。**不能省**：AI 复核 reject 会写 visibility='hidden'
		// （aireview/sql.go 的 sqlUpdateTopic），而全仓只有两处写 visibility —— AI 只写 hidden、
		// DeleteTopic 只写 deleted，**没有任何路径能改回 normal**。少了它：管理员点「通过」→
		// 队列里消失、作者收到「通过」通知、帖子在首页/分区/搜索/主页全看不到，前端又只看
		// review_state（连横幅都没有）—— 一个谁也修不回来的死状态。
		"       visibility    = CASE WHEN $6::boolean THEN 'normal' ELSE visibility END,",
		"       updated_at    = $5",
		// $7 只判「我读到的那一版」：作者在管理员点通过之前改了正文（PATCH 带 content_md 会回
		// pending 并换内容），这次判定就不该落到新内容上 —— 影响 0 行，service 换冲突错。
		// $8 是**内容的版本**。只比 review_state 不够：作者在审核员看队列之后改了正文时，
		// 主题是 pending → pending，状态一个字没变，而正文换了一份 —— 这时批准等于放出一份
		// 没人看过的内容。版本不符 → 0 行 → service 换冲突错，让审核员刷新重判。
		" WHERE id = $1 AND visibility <> 'deleted' AND review_state = $7",
		"   AND ($8::timestamptz IS NULL OR updated_at = $8)",
	), topicID, state, note, reviewerID, now.UTC(), unhide, expectState, expectUpdatedAt)
	return int(n), err
}

// InsertReviewAudit 是人工判定的审计行。AI 那一侧走 aireview/sql.go 的 sqlInsertAudit，
// 动作名不同（topic.review vs topic.ai_hide），表是同一张。
// target_id 存**对外 id**：audit_logs.target_id 是 varchar，按 0003_authz 的约定存 public_id。
func InsertReviewAudit(ctx context.Context, tx Querier, actorID int64, action, publicID string,
	detail []byte, now time.Time) error {
	return exec(ctx, tx,
		"INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, created_at) "+
			"VALUES ($1, $2, 'topic', $3, $4::jsonb, $5)",
		actorID, action, publicID, string(detail), now.UTC())
}
