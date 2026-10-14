// Package pgsql 是 follow 的原生 SQL 落点（开发必读 §1 第 8 条：SQL 只在本包与手写迁移里）。
//
// 本域的表只有 follows 一张（0040），没有 ent schema —— 与 appeal 同一个理由：
// 它不是实体图里的一环，为一张两列的表生成一套 ent 只会多一层要跟着迁移改的代码。
// 只依赖 *ent.Client 的 ExecContext / QueryContext（ent 生成时开了 sql/execquery），
// 与 notify/pgsql、platform/search/pgsql 同一套做法。
package pgsql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"forum/internal/ent"
)

// Store 无状态：所有方法都能并发调。
type Store struct{ db *ent.Client }

func New(db *ent.Client) *Store { return &Store{db: db} }

func (s *Store) query(ctx context.Context, sqlText string, args []any, scan func(*sql.Rows) error) error {
	rows, err := s.db.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Store) queryOne(ctx context.Context, sqlText string, args []any, scan func(*sql.Rows) error) error {
	rows, err := s.db.QueryContext(ctx, sqlText, args...)
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
	return scan(rows)
}

// ErrNoRows 让 service 不必 import database/sql。
var ErrNoRows = sql.ErrNoRows

func IsNoRows(err error) bool { return errors.Is(err, sql.ErrNoRows) }

// ============================================================
// 幂等写入：ON CONFLICT DO NOTHING，RowsAffected 就是「这次真的关注了吗」
// ============================================================

const followUserSQL = `
INSERT INTO follows (follower_id, user_id) VALUES ($1, $2)
ON CONFLICT (follower_id, user_id) WHERE user_id IS NOT NULL DO NOTHING`

// FollowUser 返回 true = 这次新插了一行；false = 本来就关注着（幂等重放）。
func (s *Store) FollowUser(ctx context.Context, followerID, userID int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, followUserSQL, followerID, userID)
	if err != nil {
		return false, fmt.Errorf("follow: follow user: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("follow: follow user rows: %w", err)
	}
	return n > 0, nil
}

const followBoardSQL = `
INSERT INTO follows (follower_id, board_id) VALUES ($1, $2)
ON CONFLICT (follower_id, board_id) WHERE board_id IS NOT NULL DO NOTHING`

func (s *Store) FollowBoard(ctx context.Context, followerID, boardID int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, followBoardSQL, followerID, boardID)
	if err != nil {
		return false, fmt.Errorf("follow: follow board: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("follow: follow board rows: %w", err)
	}
	return n > 0, nil
}

// 取关也是幂等：取消一个不存在的关注返回 false（接口仍然 204，d4 §7 的同一条口径）。
const unfollowUserSQL = `DELETE FROM follows WHERE follower_id = $1 AND user_id = $2`

func (s *Store) UnfollowUser(ctx context.Context, followerID, userID int64) (bool, error) {
	return s.del(ctx, unfollowUserSQL, followerID, userID)
}

const unfollowBoardSQL = `DELETE FROM follows WHERE follower_id = $1 AND board_id = $2`

func (s *Store) UnfollowBoard(ctx context.Context, followerID, boardID int64) (bool, error) {
	return s.del(ctx, unfollowBoardSQL, followerID, boardID)
}

func (s *Store) del(ctx context.Context, sqlText string, args ...any) (bool, error) {
	res, err := s.db.ExecContext(ctx, sqlText, args...)
	if err != nil {
		return false, fmt.Errorf("follow: unfollow: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("follow: unfollow rows: %w", err)
	}
	return n > 0, nil
}

// ============================================================
// 计数与状态
// ============================================================

// CountUserFollowers / CountBoardFollowers 现算（d3-forum §3.3 Q2e 的口径：不落计数列）。
// 走 idx_follows_user / idx_follows_board 的 index-only 扫。
const countUserFollowersSQL = `SELECT count(*) FROM follows WHERE user_id = $1`
const countBoardFollowersSQL = `SELECT count(*) FROM follows WHERE board_id = $1`

func (s *Store) CountUserFollowers(ctx context.Context, userID int64) (int, error) {
	return s.count(ctx, countUserFollowersSQL, userID)
}

func (s *Store) CountBoardFollowers(ctx context.Context, boardID int64) (int, error) {
	return s.count(ctx, countBoardFollowersSQL, boardID)
}

func (s *Store) count(ctx context.Context, sqlText string, id int64) (int, error) {
	var n int
	if err := s.queryOne(ctx, sqlText, []any{id}, func(rows *sql.Rows) error { return rows.Scan(&n) }); err != nil {
		return 0, fmt.Errorf("follow: count: %w", err)
	}
	return n, nil
}

const followingUserSQL = `SELECT 1 FROM follows WHERE follower_id = $1 AND user_id = $2`
const followingBoardSQL = `SELECT 1 FROM follows WHERE follower_id = $1 AND board_id = $2`

func (s *Store) FollowingUser(ctx context.Context, followerID, userID int64) (bool, error) {
	return s.exists(ctx, followingUserSQL, followerID, userID)
}

func (s *Store) FollowingBoard(ctx context.Context, followerID, boardID int64) (bool, error) {
	return s.exists(ctx, followingBoardSQL, followerID, boardID)
}

func (s *Store) exists(ctx context.Context, sqlText string, args ...any) (bool, error) {
	var one int
	err := s.queryOne(ctx, sqlText, args, func(rows *sql.Rows) error { return rows.Scan(&one) })
	if IsNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("follow: exists: %w", err)
	}
	return true, nil
}

// ============================================================
// 列表（游标：created_at DESC, id DESC，与别域同一套）
// ============================================================

// joinUser 是列表行共用的作者取数，**照抄 forum/pgsql 的那一串 COALESCE**（posts.go:31 等十来处逐字相同）：
// 昵称空回落 username、头像空回落默认头像池、小图空先回落大图再回落默认。
// 三级回落必须在 SQL 里做（forum/dto.go 的 UserBriefDTO 注释就是这条账），
// 而且**列名只有 default_avatar_hash 一根** —— 小图没有自己的默认列。
const joinUser = `
       u.public_id::text, u.username, COALESCE(NULLIF(u.nickname, ''), u.username),
       COALESCE(NULLIF(u.avatar_hash, ''), u.default_avatar_hash, ''),
       COALESCE(NULLIF(u.avatar_small_hash, ''), NULLIF(u.avatar_hash, ''), u.default_avatar_hash, ''),`

// 粉丝列表：user_id 命中看「谁关注了 TA」，follower_id 命中看「我关注了谁」。
// 用户不存在 / 已注销由 service 先判（这里是纯查询）。
const listUserFollowersSQL = `
SELECT f.created_at, f.id,` + joinUser + `
       u.id
  FROM follows f
  JOIN users u ON u.id = f.follower_id
 WHERE f.user_id = $1
   AND ($2::timestamptz IS NULL OR (f.created_at, f.id) < ($2::timestamptz, $3::bigint))
 ORDER BY f.created_at DESC, f.id DESC
 LIMIT $4`

// followingUsersSQL 与上一条**只差方向**，但多一个 u.status 过滤：
// 「我关注的人」里已注销（status='deleted'）的不该再出现（点进去是 404）—— 而粉丝列表不能过滤，
// 否则计数与列表对不上（同一份数据两种口径是这份账里最常见的病）。
const listFollowingUsersSQL = `
SELECT f.created_at, f.id,` + joinUser + `
       u.id
  FROM follows f
  JOIN users u ON u.id = f.user_id
 WHERE f.follower_id = $1 AND u.status <> 'deleted'
   AND ($2::timestamptz IS NULL OR (f.created_at, f.id) < ($2::timestamptz, $3::bigint))
 ORDER BY f.created_at DESC, f.id DESC
 LIMIT $4`

// UserRow 是一行用户（关注者 / 我关注的人）。
//
// **两个 id 要分清，这里踩过一次**：FollowID 是 follows 那一行的 id（游标就是它 ——
// 排序键是 (f.created_at, f.id)，游标必须与排序键同源），UserID 是被关注/关注者这个人的内部 id。
// 第一版把 public_id 当游标、却拿 UserID 的位子去对 f.id，于是「按 f.id 分页」的比较永远错位 ——
// 同一时间戳的三行里第一行每页都会重复出现（实测：ccc 出现两次）。
type UserRow struct {
	FollowedAt  time.Time
	FollowID    int64 // follows.id = 游标键
	PublicID    string
	Handle      string
	Nickname    string
	Avatar      string
	AvatarSmall string
	UserID      int64
}

func (s *Store) ListUserFollowers(ctx context.Context, userID int64, at *time.Time, cursorID int64, limit int) ([]UserRow, error) {
	return s.listUsers(ctx, listUserFollowersSQL, userID, at, cursorID, limit)
}

func (s *Store) ListFollowingUsers(ctx context.Context, followerID int64, at *time.Time, cursorID int64, limit int) ([]UserRow, error) {
	return s.listUsers(ctx, listFollowingUsersSQL, followerID, at, cursorID, limit)
}

func (s *Store) listUsers(ctx context.Context, sqlText string, id int64, at *time.Time, cursorID int64, limit int) ([]UserRow, error) {
	out := make([]UserRow, 0, limit)
	err := s.query(ctx, sqlText, []any{id, at, cursorID, limit}, func(rows *sql.Rows) error {
		var r UserRow
		if err := rows.Scan(&r.FollowedAt, &r.FollowID, &r.PublicID, &r.Handle, &r.Nickname,
			&r.Avatar, &r.AvatarSmall, &r.UserID); err != nil {
			return err
		}
		out = append(out, r)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("follow: list users: %w", err)
	}
	return out, nil
}

// 分区的粉丝列表：board_id = $1。**回的是 UserRow**（关注者是人，不是分区）——
// 与「谁关注了 TA」同一个形状，所以 service 那边的分页与 DTO 组装只有一份。
const listBoardFollowersSQL = `
SELECT f.created_at, f.id,` + joinUser + `
       u.id
  FROM follows f
  JOIN users u ON u.id = f.follower_id
 WHERE f.board_id = $1
   AND ($2::timestamptz IS NULL OR (f.created_at, f.id) < ($2::timestamptz, $3::bigint))
 ORDER BY f.created_at DESC, f.id DESC
 LIMIT $4`

// 「我关注的分区」：status='active' 之外的（归档）不再出现 —— 它们发不了帖，
// 留在列表里点进去只会得到「已归档」（与 users.status 那条同一个口径）。
const listFollowingBoardsSQL = `
SELECT f.created_at, f.id, b.slug, b.name, b.description, b.cover_hash, b.id
  FROM follows f
  JOIN boards b ON b.id = f.board_id
 WHERE f.follower_id = $1 AND b.status = 'active'
   AND ($2::timestamptz IS NULL OR (f.created_at, f.id) < ($2::timestamptz, $3::bigint))
 ORDER BY f.created_at DESC, f.id DESC
 LIMIT $4`

// BoardRow 是一行分区。FollowID 是 follows 那一行的 id = 游标键（与 UserRow 同一条口径：
// 排序键是 (f.created_at, f.id)，游标必须与排序键同源）。
type BoardRow struct {
	FollowedAt  time.Time
	FollowID    int64
	Slug        string
	Name        string
	Description string
	CoverHash   *string
	BoardID     int64
}

func (s *Store) ListBoardFollowers(ctx context.Context, boardID int64, at *time.Time, cursorID int64, limit int) ([]UserRow, error) {
	return s.listUsers(ctx, listBoardFollowersSQL, boardID, at, cursorID, limit)
}

func (s *Store) ListFollowingBoards(ctx context.Context, followerID int64, at *time.Time, cursorID int64, limit int) ([]BoardRow, error) {
	return s.listBoards(ctx, listFollowingBoardsSQL, followerID, at, cursorID, limit)
}

func (s *Store) listBoards(ctx context.Context, sqlText string, id int64, at *time.Time, cursorID int64, limit int) ([]BoardRow, error) {
	out := make([]BoardRow, 0, limit)
	err := s.query(ctx, sqlText, []any{id, at, cursorID, limit}, func(rows *sql.Rows) error {
		var r BoardRow
		var cover sql.NullString
		if err := rows.Scan(&r.FollowedAt, &r.FollowID, &r.Slug, &r.Name, &r.Description, &cover, &r.BoardID); err != nil {
			return err
		}
		if cover.Valid {
			r.CoverHash = &cover.String
		}
		out = append(out, r)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("follow: list boards: %w", err)
	}
	return out, nil
}

// ============================================================
// 解 slug / handle → 内部 id（写路径要 id，读路径要存在性）
// ============================================================

// BoardIDBySlug：**归档分区也要能关注/取关**（归档只拦发帖，读与关注都还在）。
// 所以只按 slug 取，不过滤 status —— 取不到 = 这个 slug 不存在（404）。
const boardIDBySlugSQL = `SELECT id FROM boards WHERE slug = $1`

func (s *Store) BoardIDBySlug(ctx context.Context, slug string) (int64, error) {
	var id int64
	if err := s.queryOne(ctx, boardIDBySlugSQL, []any{slug}, func(rows *sql.Rows) error { return rows.Scan(&id) }); err != nil {
		if IsNoRows(err) {
			return 0, err
		}
		return 0, fmt.Errorf("follow: board by slug: %w", err)
	}
	return id, nil
}

// UserIDByHandle：大小写不敏感（与 user 域的 GetProfile 同一个口径：handle 就是 username）。
const userIDByHandleSQL = `SELECT id FROM users WHERE lower(username) = lower($1) AND status <> 'deleted'`

func (s *Store) UserIDByHandle(ctx context.Context, handle string) (int64, error) {
	var id int64
	if err := s.queryOne(ctx, userIDByHandleSQL, []any{handle}, func(rows *sql.Rows) error { return rows.Scan(&id) }); err != nil {
		if IsNoRows(err) {
			return 0, err
		}
		return 0, fmt.Errorf("follow: user by handle: %w", err)
	}
	return id, nil
}
