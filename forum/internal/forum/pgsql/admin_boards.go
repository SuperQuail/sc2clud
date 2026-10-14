package pgsql

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// 管理端分区读路径（交接单 C2）。公开列表（boards.go 的 boardSelect）只给 active 分区与三个统计，
// 后台还要归档分区、排序位置与版主名单 —— 所以是另一条 SQL，不是给公开那条加开关。

// AdminBoardRow 是后台分区列表与详情共用的一行。
type AdminBoardRow struct {
	ID           int64
	PublicID     string
	Slug         string
	Name         string
	Description  string
	CoverHash    *string
	Status       string
	ACLEnabled   bool
	MinPostLevel int
	// Position 是 sort 升序下的行号（1 起），展示用；重排只认请求里 ids 的顺序。
	Position   int
	TopicCount int64
	PostCount  int64
	TodayCount int64
	// Moderators 只含**未过期**的任期：过期的留在库里当历史，判 board.moderate 的 SQL 也不看它们。
	Moderators []AdminModerator
}

// AdminModerator 是一行未过期的版主任期。ExpiresAt 为 null = 永久。
type AdminModerator struct {
	UserID    string     `json:"user_id"`
	Handle    string     `json:"handle"`
	Nickname  string     `json:"nickname"`
	GrantedAt time.Time  `json:"granted_at"`
	ExpiresAt *time.Time `json:"expires_at"`
}

// 列、统计、版主聚合三段分开命名：三处查询（列表 / 按 id / 按 public_id）差别只在最后那个谓词，
// 拼一份公共前缀比抄三遍好（抄三遍就会有一处忘了带 grown_at 或今天的零点）。
const adminBoardColumns = `
SELECT b.id, b.public_id, b.slug, b.name, b.description, b.cover_hash, b.status,
       b.acl_enabled, b.min_post_level,
       row_number() OVER (ORDER BY b.sort, b.id) AS position,
       live.topic_count, live.post_count, live.today_count,
       mods.moderators
  FROM boards b
  LEFT JOIN LATERAL (
    SELECT count(*)                                   AS topic_count,
           coalesce(sum(t.reply_count), 0)            AS post_count,
           count(*) FILTER (WHERE t.created_at >= $1) AS today_count
      FROM topics t
     WHERE t.board_id = b.id AND t.visibility = $2 AND t.review_state = $3
  ) live ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(json_agg(json_build_object(
             'user_id', u.public_id::text,
             'handle', u.username,
             'nickname', coalesce(nullif(u.nickname, ''), u.username),
             'granted_at', m.granted_at,
             'expires_at', m.expires_at) ORDER BY m.granted_at, m.id), '[]'::json) AS moderators
      FROM board_moderators m
      JOIN users u ON u.id = m.user_id
     WHERE m.board_id = b.id AND m.grown_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > $4)
  ) mods ON true`

// adminBoardWhere 是公共谓词：$5 为 NULL 时是列表，非空时按自增 id 取一行。
const adminBoardWhere = `
 WHERE ($5::bigint IS NULL OR b.id = $5)`

// adminBoardByPublicIDSQL 按对外 ID 取一行（$6）。
const adminBoardByPublicIDSQL = adminBoardColumns + adminBoardWhere + "\n   AND b.public_id = $6"

const adminBoardsSQL = adminBoardColumns + adminBoardWhere + "\n ORDER BY b.sort, b.id"

// scanAdminBoard 扫一行。moderators 走 JSON 聚合取回来：PostgreSQL 的复合类型文本
// （(1,2,"a","b")）要自己解析引号与逗号，json 不用。
func scanAdminBoard(rows *sql.Rows) (AdminBoardRow, error) {
	var b AdminBoardRow
	var cover sql.NullString
	var mods []byte
	if err := rows.Scan(&b.ID, &b.PublicID, &b.Slug, &b.Name, &b.Description, &cover, &b.Status,
		&b.ACLEnabled, &b.MinPostLevel, &b.Position,
		&b.TopicCount, &b.PostCount, &b.TodayCount, &mods); err != nil {
		return b, err
	}
	b.CoverHash = scanNullString(cover)
	b.Moderators = []AdminModerator{}
	if len(mods) > 0 {
		if err := json.Unmarshal(mods, &b.Moderators); err != nil {
			return b, err
		}
	}
	return b, nil
}

// AdminBoards 是后台列表（含归档分区）。todayStart 由 service 按站点时区算好。
func (s *Store) AdminBoards(ctx context.Context, todayStart time.Time) ([]AdminBoardRow, error) {
	var out []AdminBoardRow
	err := s.query(ctx, adminBoardsSQL, []any{todayStart.UTC(), "normal", "approved", time.Now().UTC(), nil},
		func(rows *sql.Rows) error {
			b, err := scanAdminBoard(rows)
			if err != nil {
				return err
			}
			out = append(out, b)
			return nil
		})
	return out, err
}

// AdminBoardByID 取一行（写路径重读 / 重排的校验）。
func (s *Store) AdminBoardByID(ctx context.Context, id int64, todayStart time.Time) (*AdminBoardRow, error) {
	return s.adminBoardOne(ctx, adminBoardsSQL, todayStart, id, "")
}

// AdminBoardByPublicID 按对外 ID 取一行（路由参数一律 uuid，见 migrations/0050）。
func (s *Store) AdminBoardByPublicID(ctx context.Context, publicID string, todayStart time.Time) (*AdminBoardRow, error) {
	return s.adminBoardOne(ctx, adminBoardByPublicIDSQL, todayStart, nil, publicID)
}

func (s *Store) adminBoardOne(ctx context.Context, sqlText string, todayStart time.Time, id any, publicID string) (*AdminBoardRow, error) {
	var found *AdminBoardRow
	args := []any{todayStart.UTC(), "normal", "approved", time.Now().UTC(), id}
	if publicID != "" {
		args = append(args, publicID)
	}
	err := s.queryOne(ctx, sqlText, args, func(rows *sql.Rows) error {
		b, err := scanAdminBoard(rows)
		if err != nil {
			return err
		}
		found = &b
		return nil
	})
	if err != nil {
		return nil, err
	}
	return found, nil
}
