// Package pgsql 是 notify 的原生 SQL 落点（开发必读 §1 第 8 条：SQL 只在本包与手写迁移里）。
//
// 只依赖 *ent.Client 与 *ent.Tx 共有的 ExecContext / QueryContext（ent 生成时开了 sql/execquery，
// 与 platform/search/pgsql 同一套做法），所以同一份查询既能跑在请求路径上，也能跑在事务里。
package pgsql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"forum/internal/ent"
)

// execQuery 是 ent.Client 与 ent.Tx 共有的最小接口。
type execQuery interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Queries 无状态：New 用于请求路径，NewTx 用于把写放进调用方的事务。
type Queries struct{ db execQuery }

func New(db *ent.Client) *Queries { return &Queries{db: db} }

// NewTx 与业务写同事务（notify.Create 用）。
func NewTx(tx *ent.Tx) *Queries { return &Queries{db: tx} }

// scanOne 跑一条单行查询：没有行时返回 sql.ErrNoRows（ent 的 config 只暴露 QueryContext）。
func (q *Queries) scanOne(ctx context.Context, dest []any, query string, args ...any) error {
	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return err
		}
		return sql.ErrNoRows
	}
	return rows.Scan(dest...)
}

// ============================================================
// 列表 / 角标 / 已读 / 静音 / 清理
// ============================================================

// 通知列表（d4 §4.1）：游标行序比较 + actor 现取资料。
//
// uuid / jsonb 一律 ::text 取回：database/sql 下不让驱动去猜 uuid 与 jsonb 的 Go 类型。
// actor 已注销（status='deleted'）时 LEFT JOIN 出 NULL，前端渲染「已注销」（d4 §5.1）。
const listSQL = `
SELECT n.id, n.public_id::text, n.type, n.payload::text, n.link, n.read_at, n.created_at,
       a.username, COALESCE(NULLIF(a.nickname, ''), a.username), a.avatar_hash, a.avatar_small_hash
  FROM notifications n
  LEFT JOIN users a ON a.id = n.actor_id AND a.status <> 'deleted'
 WHERE n.user_id = $1
   AND n.deleted_at IS NULL
   AND ($2::timestamptz IS NULL OR (n.created_at, n.id) < ($2::timestamptz, $3::bigint))
   AND ($4::text = '' OR n.type = $4)
   AND ($5::bool = false OR n.read_at IS NULL)
 ORDER BY n.created_at DESC, n.id DESC
 LIMIT $6`

// NotificationRow 是列表的一行。**内部 id 只用于游标兜底**，不出现在响应里（拍板 §5.6）。
type NotificationRow struct {
	ID               int64
	PublicID         string
	Kind             string
	Payload          string
	Link             string
	ReadAt           *time.Time
	CreatedAt        time.Time
	ActorUsername    *string
	ActorNickname    *string
	ActorAvatar      *string
	ActorAvatarSmall *string
}

func (q *Queries) ListNotifications(ctx context.Context, userID int64, at *time.Time, cursorID int64,
	kind string, unreadOnly bool, limit int) ([]NotificationRow, error) {
	rows, err := q.db.QueryContext(ctx, listSQL, userID, at, cursorID, kind, unreadOnly, limit)
	if err != nil {
		return nil, fmt.Errorf("notify: list: %w", err)
	}
	defer rows.Close()

	out := make([]NotificationRow, 0, limit)
	for rows.Next() {
		var r NotificationRow
		if err := rows.Scan(&r.ID, &r.PublicID, &r.Kind, &r.Payload, &r.Link, &r.ReadAt, &r.CreatedAt,
			&r.ActorUsername, &r.ActorNickname, &r.ActorAvatar, &r.ActorAvatarSmall); err != nil {
			return nil, fmt.Errorf("notify: scan list: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// 未读角标（d4 §4.2）：谓词与 idx_notifications_unread 逐字一致（差一个字就会退化成 Seq Scan）。
const unreadCountSQL = `
SELECT count(*) FROM notifications
 WHERE user_id = $1 AND read_at IS NULL AND deleted_at IS NULL`

func (q *Queries) UnreadCount(ctx context.Context, userID int64) (int, error) {
	var n int
	if err := q.scanOne(ctx, []any{&n}, unreadCountSQL, userID); err != nil {
		return 0, fmt.Errorf("notify: unread count: %w", err)
	}
	return n, nil
}

// 批量已读（d4 §4.3）：read_at IS NULL 让并发重放改 0 行。
const markReadSQL = `
UPDATE notifications SET read_at = $2
 WHERE user_id = $1 AND read_at IS NULL
   AND ($3::bool OR public_id = ANY($4::uuid[]))`

func (q *Queries) MarkRead(ctx context.Context, userID int64, at time.Time, all bool, publicIDs []string) (int, error) {
	res, err := q.db.ExecContext(ctx, markReadSQL, userID, at, all, publicIDs)
	if err != nil {
		return 0, fmt.Errorf("notify: mark read: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("notify: mark read rows: %w", err)
	}
	return int(n), nil
}

// 通知写入（d4 §4.4）：ON CONFLICT 必须带与部分唯一索引逐字相同的谓词，否则 PG 推断不到那个索引。
const insertSQL = `
INSERT INTO notifications (public_id, user_id, actor_id, type, payload, link, dedup_key, created_at)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8)
ON CONFLICT (user_id, dedup_key) WHERE dedup_key <> '' DO NOTHING`

func (q *Queries) InsertNotification(ctx context.Context, publicID string, userID int64, actorID *int64,
	kind, payload, link, dedupKey string, at time.Time) error {
	if _, err := q.db.ExecContext(ctx, insertSQL, publicID, userID, actorID, kind, payload, link, dedupKey, at); err != nil {
		return fmt.Errorf("notify: insert: %w", err)
	}
	return nil
}

// 静音匹配（d4 §4.5）：整类静音命中 type，单条内容静音命中 link key。命中即不生成行。
const mutedSQL = `
SELECT 1 FROM notification_mutes
 WHERE user_id = $1
   AND ((type = $2 AND target_key = '') OR (type = 'link' AND target_key = $3))
 LIMIT 1`

func (q *Queries) Muted(ctx context.Context, userID int64, kind, targetKey string) (bool, error) {
	var one int
	err := q.scanOne(ctx, []any{&one}, mutedSQL, userID, kind, targetKey)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("notify: muted: %w", err)
	}
	return true, nil
}

const setMuteSQL = `
INSERT INTO notification_mutes (user_id, type, target_key, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING`

func (q *Queries) SetMute(ctx context.Context, userID int64, kind, targetKey string, at time.Time) error {
	if _, err := q.db.ExecContext(ctx, setMuteSQL, userID, kind, targetKey, at); err != nil {
		return fmt.Errorf("notify: set mute: %w", err)
	}
	return nil
}

const unsetMuteSQL = `
DELETE FROM notification_mutes WHERE user_id = $1 AND type = $2 AND target_key = $3`

func (q *Queries) UnsetMute(ctx context.Context, userID int64, kind, targetKey string) error {
	if _, err := q.db.ExecContext(ctx, unsetMuteSQL, userID, kind, targetKey); err != nil {
		return fmt.Errorf("notify: unset mute: %w", err)
	}
	return nil
}

// 清理（d4 §5.5）：分批硬删软删超过保留期的行（部分索引里的死元组会拖慢未读 COUNT）。
const purgeSQL = `
DELETE FROM notifications WHERE id IN (
  SELECT id FROM notifications WHERE deleted_at < $1 LIMIT $2)`

func (q *Queries) Purge(ctx context.Context, before time.Time, limit int) (int, error) {
	res, err := q.db.ExecContext(ctx, purgeSQL, before, limit)
	if err != nil {
		return 0, fmt.Errorf("notify: purge: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("notify: purge rows: %w", err)
	}
	return int(n), nil
}

// ============================================================
// 任务入口要读的别人的表（只读；notify 是这些事件的消费者，d4 §5.1）
// ============================================================

// ActiveUsers 返回「存在且 active」的用户；banned / deleted 都不发通知（d4 §5.1）。
// 顺带取 username：打赏通知的 link 指向收款人主页。
const activeUsersSQL = `
SELECT id, username FROM users WHERE id = ANY($1::bigint[]) AND status = 'active'`

func (q *Queries) ActiveUsers(ctx context.Context, ids []int64) (map[int64]string, error) {
	rows, err := q.db.QueryContext(ctx, activeUsersSQL, ids)
	if err != nil {
		return nil, fmt.Errorf("notify: active users: %w", err)
	}
	defer rows.Close()

	out := make(map[int64]string, len(ids))
	for rows.Next() {
		var id int64
		var username string
		if err := rows.Scan(&id, &username); err != nil {
			return nil, fmt.Errorf("notify: scan active users: %w", err)
		}
		out[id] = username
	}
	return out, rows.Err()
}

// ReplyTarget 是回复通知需要的两件事：主题作者，以及楼中楼的父楼层作者（d4 §5.1 ①）。
type ReplyTarget struct {
	TopicPublicID  string
	TopicAuthorID  int64
	ParentAuthorID *int64
}

const replyTargetSQL = `
SELECT t.public_id::text, t.author_id, pp.author_id
  FROM posts p
  JOIN topics t ON t.id = p.topic_id
  LEFT JOIN posts pp ON pp.id = p.parent_id
 WHERE p.id = $1`

func (q *Queries) ReplyTarget(ctx context.Context, postID int64) (ReplyTarget, error) {
	var t ReplyTarget
	err := q.scanOne(ctx, []any{&t.TopicPublicID, &t.TopicAuthorID, &t.ParentAuthorID}, replyTargetSQL, postID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return t, err
		}
		return t, fmt.Errorf("notify: reply target: %w", err)
	}
	return t, nil
}

// LikeTarget 是被赞对象的作者与它所属的主题页（topic 赞时两者是同一行）。
type LikeTarget struct {
	AuthorID      int64
	TopicPublicID string
}

const likePostTargetSQL = `
SELECT p.author_id, t.public_id::text
  FROM posts p JOIN topics t ON t.id = p.topic_id
 WHERE p.id = $1`

const likeTopicTargetSQL = `
SELECT t.author_id, t.public_id::text FROM topics t WHERE t.id = $1`

// issue 评论的赞：通知对象是评论作者，link 仍指向主题页。
const likeCommentTargetSQL = `
SELECT c.author_id, t.public_id::text
  FROM issue_comments c
  JOIN post_issues i ON i.id = c.issue_id
  JOIN topics t      ON t.id = i.topic_id
 WHERE c.id = $1`

func (q *Queries) LikePostTarget(ctx context.Context, postID int64) (LikeTarget, error) {
	return q.likeTarget(ctx, likePostTargetSQL, postID, "post")
}

func (q *Queries) LikeTopicTarget(ctx context.Context, topicID int64) (LikeTarget, error) {
	return q.likeTarget(ctx, likeTopicTargetSQL, topicID, "topic")
}

func (q *Queries) LikeCommentTarget(ctx context.Context, commentID int64) (LikeTarget, error) {
	return q.likeTarget(ctx, likeCommentTargetSQL, commentID, "comment")
}

func (q *Queries) likeTarget(ctx context.Context, query string, id int64, what string) (LikeTarget, error) {
	var t LikeTarget
	err := q.scanOne(ctx, []any{&t.AuthorID, &t.TopicPublicID}, query, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return t, err
		}
		return t, fmt.Errorf("notify: like target (%s): %w", what, err)
	}
	return t, nil
}

const topicPublicIDSQL = `SELECT public_id::text FROM topics WHERE id = $1`

func (q *Queries) TopicPublicID(ctx context.Context, topicID int64) (string, error) {
	var s string
	if err := q.scanOne(ctx, []any{&s}, topicPublicIDSQL, topicID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		return "", fmt.Errorf("notify: topic public id: %w", err)
	}
	return s, nil
}

// RewardTarget 是打赏通知需要的收款人与金额（state 必须是 approved，d4 §5.1 ④）。
type RewardTarget struct {
	RecipientID       int64
	RecipientUsername string
	AmountCents       int64
}

const rewardTargetSQL = `
SELECT d.recipient_id, u.username, d.amount_cents
  FROM donation_records d
  JOIN users u ON u.id = d.recipient_id
 WHERE d.id = $1 AND d.state = 'approved'`

func (q *Queries) RewardTarget(ctx context.Context, donationID int64) (RewardTarget, error) {
	var t RewardTarget
	err := q.scanOne(ctx, []any{&t.RecipientID, &t.RecipientUsername, &t.AmountCents}, rewardTargetSQL, donationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return t, err
		}
		return t, fmt.Errorf("notify: reward target: %w", err)
	}
	return t, nil
}

// ReviewTarget 是审核结果通知的对象：收件人是主题作者，状态与理由现读（d4 §5.1 ⑤）。
type ReviewTarget struct {
	AuthorID      int64
	TopicPublicID string
	State         string
	Note          string
	ReviewedBy    int64 // 0 = 不是人判的（AI / 系统），通知的 actor 为 NULL
}

const reviewTargetSQL = `
SELECT author_id, public_id::text, review_state, COALESCE(review_note, ''), COALESCE(reviewed_by, 0)
  FROM topics WHERE id = $1`

func (q *Queries) ReviewTarget(ctx context.Context, topicID int64) (ReviewTarget, error) {
	var t ReviewTarget
	err := q.scanOne(ctx, []any{&t.AuthorID, &t.TopicPublicID, &t.State, &t.Note, &t.ReviewedBy}, reviewTargetSQL, topicID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return t, err
		}
		return t, fmt.Errorf("notify: review target: %w", err)
	}
	return t, nil
}

// SanctionTarget 是处罚通知的对象（d4 §5.1 ⑥）。until 为 NULL 表示永久。
type SanctionTarget struct {
	UserID int64
	Until  *time.Time
	Reason string
}

const sanctionTargetSQL = `
SELECT user_id, until, reason FROM sanctions WHERE id = $1`

func (q *Queries) SanctionTarget(ctx context.Context, sanctionID int64) (SanctionTarget, error) {
	var t SanctionTarget
	err := q.scanOne(ctx, []any{&t.UserID, &t.Until, &t.Reason}, sanctionTargetSQL, sanctionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return t, err
		}
		return t, fmt.Errorf("notify: sanction target: %w", err)
	}
	return t, nil
}
