// Package pgsql 是 title 的原生 SQL 落点（开发必读 §1 第 8 条）。
//
// 为什么会话与持有关系走原生 SQL：这两处都是 user_titles × titles 的 join（一次取回目录字段），
// ent 要 WithTitle 再手工映射一遍——d4 §4 把这类非平凡查询收进本包，就是为这一步。
package pgsql

import (
	"context"
	"database/sql"
	"errors"
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
// 持有关系（d4 §4.12 / §5.3）
// ============================================================

// HeldTitle 是一行「某人持有的头衔」。归档的也返回（历史事实要在用户页显示）。
type HeldTitle struct {
	ID          int64
	PublicID    string
	Key         string
	Name        string
	Color       string
	Description string
	ArchivedAt  *time.Time
}

const userTitlesSQL = `
SELECT t.id, t.public_id::text, t.key, t.name, t.color, t.description, t.archived_at
  FROM user_titles ut
  JOIN titles t ON t.id = ut.title_id
 WHERE ut.user_id = $1
 ORDER BY ut.granted_at, t.id`

func (q *Queries) UserTitles(ctx context.Context, userID int64) ([]HeldTitle, error) {
	rows, err := q.db.QueryContext(ctx, userTitlesSQL, userID)
	if err != nil {
		return nil, fmt.Errorf("title: user titles: %w", err)
	}
	defer rows.Close()

	out := make([]HeldTitle, 0, 4)
	for rows.Next() {
		var h HeldTitle
		if err := rows.Scan(&h.ID, &h.PublicID, &h.Key, &h.Name, &h.Color, &h.Description, &h.ArchivedAt); err != nil {
			return nil, fmt.Errorf("title: scan user titles: %w", err)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// TitleByPublicID 返回内部 id 与归档态；不存在 → sql.ErrNoRows。
func (q *Queries) TitleByPublicID(ctx context.Context, publicID string) (int64, bool, error) {
	var (
		id       int64
		archived bool
	)
	if err := q.scanOne(ctx, []any{&id, &archived},
		"SELECT id, archived_at IS NOT NULL FROM titles WHERE public_id = $1::uuid", publicID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, err
		}
		return 0, false, fmt.Errorf("title: title by public id: %w", err)
	}
	return id, archived, nil
}

// HeldTitleID 回答「他是不是真的持有这个头衔、且没归档」（d4 §4.12 ①）。
func (q *Queries) HeldTitleID(ctx context.Context, userID int64, publicID string) (int64, bool, error) {
	var (
		id       int64
		archived bool
	)
	if err := q.scanOne(ctx, []any{&id, &archived}, `
SELECT t.id, t.archived_at IS NOT NULL
  FROM user_titles ut
  JOIN titles t ON t.id = ut.title_id
 WHERE ut.user_id = $1 AND t.public_id = $2::uuid`, userID, publicID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, err
		}
		return 0, false, fmt.Errorf("title: held title: %w", err)
	}
	return id, archived, nil
}

// 授予幂等：已持有 → 0 行、不报错（d4 §5.3）。
const grantTitleSQL = `
INSERT INTO user_titles (user_id, title_id, granted_by, granted_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING`

func (q *Queries) GrantTitle(ctx context.Context, userID, titleID, grantedBy int64, at time.Time) error {
	if _, err := q.db.ExecContext(ctx, grantTitleSQL, userID, titleID, grantedBy, at); err != nil {
		return fmt.Errorf("title: grant: %w", err)
	}
	return nil
}

const revokeTitleSQL = `DELETE FROM user_titles WHERE user_id = $1 AND title_id = $2`

func (q *Queries) RevokeTitle(ctx context.Context, userID, titleID int64) error {
	if _, err := q.db.ExecContext(ctx, revokeTitleSQL, userID, titleID); err != nil {
		return fmt.Errorf("title: revoke: %w", err)
	}
	return nil
}

// ============================================================
// 经验与等级（d4 §4.13）
// ============================================================

// InsertExpEvent 记一笔流水。返回 false = 这一笔已经记过（幂等键命中），调用方**不能**再加经验。
const insertExpEventSQL = `
INSERT INTO exp_events (user_id, delta, reason, ref, created_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, reason, ref) WHERE ref <> '' DO NOTHING
RETURNING id`

func (q *Queries) InsertExpEvent(ctx context.Context, userID int64, delta int, reason, ref string, at time.Time) (bool, error) {
	var id int64
	if err := q.scanOne(ctx, []any{&id}, insertExpEventSQL, userID, delta, reason, ref, at); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("title: insert exp event: %w", err)
	}
	return true, nil
}

// exp 与 level 的读-改-写必须在同一句里：users 是全站写热点行，先查再加再写会在热门作者那一行排队。
const addExpSQL = `
UPDATE users
   SET exp   = exp + $2,
       level = floor(sqrt((exp + $2) / 100.0))::int + 1,
       updated_at = $3
 WHERE id = $1
RETURNING exp, level`

func (q *Queries) AddExp(ctx context.Context, userID int64, delta int, at time.Time) (int, int, error) {
	var (
		exp   int
		level int
	)
	if err := q.scanOne(ctx, []any{&exp, &level}, addExpSQL, userID, delta, at); err != nil {
		return 0, 0, fmt.Errorf("title: add exp: %w", err)
	}
	return exp, level, nil
}

const currentExpSQL = `SELECT exp, level FROM users WHERE id = $1`

func (q *Queries) CurrentExp(ctx context.Context, userID int64) (int, int, error) {
	var (
		exp   int
		level int
	)
	if err := q.scanOne(ctx, []any{&exp, &level}, currentExpSQL, userID); err != nil {
		return 0, 0, fmt.Errorf("title: current exp: %w", err)
	}
	return exp, level, nil
}
