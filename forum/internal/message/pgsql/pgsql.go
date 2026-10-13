// Package pgsql 是 message 的原生 SQL 落点（开发必读 §1 第 8 条）。
//
// 依赖 *ent.Client / *ent.Tx 共有的 ExecContext / QueryContext（ent 开了 sql/execquery）。
package pgsql

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"forum/internal/ent"
)

type execQuery interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

type Queries struct{ db execQuery }

func New(db *ent.Client) *Queries { return &Queries{db: db} }

func NewTx(tx *ent.Tx) *Queries { return &Queries{db: tx} }

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
// 会话列表：对方 + 最后一条 + 未读数，一条 SQL（d4 §4.6）
// ============================================================

// 与设计文档的差异：多了 u.username / u.nickname / u.avatar_hash / u.avatar_small_hash 四列。
// 设计那条本来就 JOIN users（过滤已注销），顺手取回对方的资料，比「再调一次 user 模块」少一次往返。
// 【与 d4 §4.6 的差异】设计里 conv 写的是 `SELECT peer, id ... GROUP BY peer`，这在 PG 是
// 42803（id 既没分组也没聚合）—— 那条 SQL 跑不起来。这里取 max(id)（= 每个会话的最后一条），
// 于是设计里为它准备的 last_msg / DISTINCT ON 也就多余了，整条少一层 CTE。
const listConversationsSQL = `
WITH conv AS (
    SELECT peer, max(id) AS last_id FROM (
        SELECT high_id AS peer, id FROM messages WHERE low_id  = $1
        UNION ALL
        SELECT low_id  AS peer, id FROM messages WHERE high_id = $1
    ) c1
     GROUP BY peer
)
SELECT l.peer, COALESCE(ux.n, 0) AS unread_count,
       m.id, m.public_id::text, m.body, m.sender_id, m.read_at, m.created_at,
       u.username, u.nickname, u.avatar_hash, u.avatar_small_hash
  FROM conv l
  JOIN users    u ON u.id = l.peer AND u.status <> 'deleted'
  JOIN messages m ON m.id = l.last_id
  LEFT JOIN (
      SELECT sender_id AS peer, count(*) AS n FROM messages
       WHERE low_id = $1 AND read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id
       GROUP BY sender_id
      UNION ALL
      SELECT sender_id AS peer, count(*) AS n FROM messages
       WHERE high_id = $1 AND read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id
       GROUP BY sender_id
  ) ux ON ux.peer = l.peer
 WHERE ($2::bigint = 0 OR l.last_id < $2)
 ORDER BY m.id DESC
 LIMIT $3`

// ConversationRow 是一行会话。LastID 只用于游标兜底，不出现在响应里。
type ConversationRow struct {
	PeerID          int64
	UnreadCount     int
	LastID          int64
	LastPublicID    string
	LastBody        string
	LastSenderID    int64
	LastReadAt      *time.Time
	LastCreatedAt   time.Time
	PeerUsername    string
	PeerNickname    string
	PeerAvatar      *string
	PeerAvatarSmall *string
}

func (q *Queries) ListConversations(ctx context.Context, me int64, beforeID int64, limit int) ([]ConversationRow, error) {
	rows, err := q.db.QueryContext(ctx, listConversationsSQL, me, beforeID, limit)
	if err != nil {
		return nil, fmt.Errorf("message: list conversations: %w", err)
	}
	defer rows.Close()

	out := make([]ConversationRow, 0, limit)
	for rows.Next() {
		var r ConversationRow
		if err := rows.Scan(&r.PeerID, &r.UnreadCount, &r.LastID, &r.LastPublicID, &r.LastBody,
			&r.LastSenderID, &r.LastReadAt, &r.LastCreatedAt,
			&r.PeerUsername, &r.PeerNickname, &r.PeerAvatar, &r.PeerAvatarSmall); err != nil {
			return nil, fmt.Errorf("message: scan conversations: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ============================================================
// 会话内消息（d4 §4.7 / §4.11）
// ============================================================

// 两条 SQL 各自与一个索引完全对齐（idx_messages_pair_low / _high）：
// 在 Go 里按 me < peer 二选一，不留 OR 让优化器猜。
const threadLowSQL = `
SELECT id, public_id::text, sender_id, body, read_at, created_at
  FROM messages
 WHERE low_id = $1 AND high_id = $2
   AND deleted_by_low = false
   AND ($3::bigint = 0 OR id < $3)
 ORDER BY id DESC
 LIMIT $4`

const threadHighSQL = `
SELECT id, public_id::text, sender_id, body, read_at, created_at
  FROM messages
 WHERE high_id = $1 AND low_id = $2
   AND deleted_by_high = false
   AND ($3::bigint = 0 OR id < $3)
 ORDER BY id DESC
 LIMIT $4`

type MessageRow struct {
	ID        int64
	PublicID  string
	SenderID  int64
	Body      string
	ReadAt    *time.Time
	CreatedAt time.Time
}

// ListThread：meIsLow 由调用方按 me < peer 算好（永远只有一支可能为真）。
func (q *Queries) ListThread(ctx context.Context, me, peer int64, meIsLow bool, beforeID int64, limit int) ([]MessageRow, error) {
	query := threadHighSQL
	if meIsLow {
		query = threadLowSQL
	}
	rows, err := q.db.QueryContext(ctx, query, me, peer, beforeID, limit)
	if err != nil {
		return nil, fmt.Errorf("message: list thread: %w", err)
	}
	defer rows.Close()

	out := make([]MessageRow, 0, limit)
	for rows.Next() {
		var r MessageRow
		if err := rows.Scan(&r.ID, &r.PublicID, &r.SenderID, &r.Body, &r.ReadAt, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("message: scan thread: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// 未读角标（d4 §4.8）：UNION ALL 两支各自走一个部分索引，Go 侧相加。
const unreadTotalSQL = `
SELECT count(*) FROM messages
 WHERE low_id = $1 AND read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id
UNION ALL
SELECT count(*) FROM messages
 WHERE high_id = $1 AND read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id`

func (q *Queries) UnreadTotal(ctx context.Context, me int64) (int, error) {
	rows, err := q.db.QueryContext(ctx, unreadTotalSQL, me)
	if err != nil {
		return 0, fmt.Errorf("message: unread total: %w", err)
	}
	defer rows.Close()

	total := 0
	for rows.Next() {
		var n int
		if err := rows.Scan(&n); err != nil {
			return 0, fmt.Errorf("message: scan unread total: %w", err)
		}
		total += n
	}
	return total, rows.Err()
}

// 发送（d4 §4.10）：规范化顺序由 LEAST/GREATEST 保证，与 ck_messages_pair_order 同一件事。
// 重复发送不去重（私信重复内容是正常对话，d4 §6.1）。
const insertMessageSQL = `
INSERT INTO messages (public_id, low_id, high_id, sender_id, body, created_at)
VALUES ($1::uuid, LEAST($2::bigint, $3::bigint), GREATEST($2::bigint, $3::bigint), $2::bigint, $4, $5)
RETURNING public_id::text, created_at`

func (q *Queries) InsertMessage(ctx context.Context, publicID string, sender, peer int64, body string, at time.Time) (string, time.Time, error) {
	var (
		outID string
		outAt time.Time
	)
	if err := q.scanOne(ctx, []any{&outID, &outAt}, insertMessageSQL, publicID, sender, peer, body, at); err != nil {
		return "", time.Time{}, fmt.Errorf("message: insert: %w", err)
	}
	return outID, outAt, nil
}

// 批量已读某会话（d4 §4.11）：只标**对方发给我**的未读，并发重放第二次改 0 行。
const markReadLowSQL = `
UPDATE messages SET read_at = $3
 WHERE low_id = $1 AND high_id = $2 AND sender_id = $2
   AND read_at IS NULL AND deleted_by_low = false`

const markReadHighSQL = `
UPDATE messages SET read_at = $3
 WHERE high_id = $1 AND low_id = $2 AND sender_id = $2
   AND read_at IS NULL AND deleted_by_high = false`

func (q *Queries) MarkThreadRead(ctx context.Context, me, peer int64, meIsLow bool, at time.Time) (int, error) {
	query := markReadHighSQL
	if meIsLow {
		query = markReadLowSQL
	}
	res, err := q.db.ExecContext(ctx, query, me, peer, at)
	if err != nil {
		return 0, fmt.Errorf("message: mark read: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("message: mark read rows: %w", err)
	}
	return int(n), nil
}

// 清理（d4 §5.5）：只有双方都删了、且超过保留期的行才硬删。
const purgeSQL = `
DELETE FROM messages WHERE id IN (
  SELECT id FROM messages
   WHERE deleted_by_low AND deleted_by_high AND created_at < $1 LIMIT $2)`

func (q *Queries) Purge(ctx context.Context, before time.Time, limit int) (int, error) {
	res, err := q.db.ExecContext(ctx, purgeSQL, before, limit)
	if err != nil {
		return 0, fmt.Errorf("message: purge: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("message: purge rows: %w", err)
	}
	return int(n), nil
}
