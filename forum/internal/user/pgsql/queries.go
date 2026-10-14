// Package pgsql 是 user 模块的原生 SQL：个人主页聚合与 @ 提及前缀搜索。
// 两条都是 ent 表达不了的（LATERAL 计数、窗口函数算重名）。
package pgsql

import (
	"context"
	"database/sql"
	"time"

	"forum/internal/auth/pgsql"
)

// ProfileSQL 是 GET /users/{handle} 的聚合查询（设计 §11.1）。
//
// lower(u.username) = lower($1) 必须逐字与 uq_users_username_lower 的表达式一致，
// 否则退化成 Seq Scan（拍板 §5.9 第 2 条 / 设计 §11.3）。
// topic_count 只算 visibility=normal 且 review_state=approved 的主题；
// like_received 只算该用户 status=normal 的帖子收到的赞（拍板 §2.2 / §3）。
const ProfileSQL = `
SELECT u.id, u.public_id, u.username, COALESCE(NULLIF(u.nickname, ''), u.username), u.bio,
       u.avatar_hash, u.avatar_small_hash, u.cover_hash,
       u.exp, u.level, u.status, u.created_at,
       t.name AS title_name, t.color AS title_color,
       COALESCE(tc.n, 0) AS topic_count,
       COALESCE(lc.n, 0) AS like_received
  FROM users u
  LEFT JOIN titles t ON t.id = u.equipped_title_id
  LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM topics tp
         WHERE tp.author_id = u.id AND tp.visibility = 'normal' AND tp.review_state = 'approved'
       ) tc ON true
  LEFT JOIN LATERAL (
        SELECT count(*) AS n
          FROM likes l JOIN posts p ON p.id = l.target_id AND l.target_type = 'post'
         WHERE p.author_id = u.id AND p.visibility = 'normal'
       ) lc ON true
 WHERE lower(u.username) = lower($1)`

// SearchSQL 是 GET /users/search?q= 的前缀候选（设计 §11.4）。
// ambiguous 用窗口函数在同一次扫描里算出，不额外查一次。
const SearchSQL = `
SELECT u.public_id, u.username, COALESCE(NULLIF(u.nickname, ''), u.username), u.avatar_hash, u.avatar_small_hash, u.level,
       -- 判重按**显示名**（昵称留空 = 显示登录名），否则两个「没设昵称、登录名相同」的人不会被标重
       (count(*) OVER (PARTITION BY lower(COALESCE(NULLIF(u.nickname, ''), u.username)))) > 1 AS ambiguous
  FROM users u
 WHERE u.status = 'active'
   AND (lower(u.username) LIKE lower($1) || '%' OR lower(u.nickname) LIKE lower($1) || '%')
 ORDER BY (lower(u.nickname) = lower($1)) DESC,
          (lower(u.username) LIKE lower($1) || '%') DESC,
          u.username ASC
 LIMIT $2`

// ProfileRow 是个人主页聚合的结果。
type ProfileRow struct {
	ID              int64
	PublicID        string
	Username        string
	Nickname        string
	Bio             string
	AvatarHash      *string
	AvatarSmallHash *string
	// CoverHash 是 0030 加的封面列（NULL = 没设过）。
	CoverHash    *string
	Exp          int
	Level        int
	Status       string
	CreatedAt    time.Time
	TitleName    *string
	TitleColor   *string
	TopicCount   int
	LikeReceived int
}

// Profile 按 handle 取一行。查不到返回 (nil, false, nil)——「没有这个人」是正常分支。
func Profile(ctx context.Context, q pgsql.Querier, handle string) (*ProfileRow, bool, error) {
	var r ProfileRow
	err := pgsql.QueryRow(ctx, q, ProfileSQL, handle).Scan(
		&r.ID, &r.PublicID, &r.Username, &r.Nickname, &r.Bio,
		&r.AvatarHash, &r.AvatarSmallHash, &r.CoverHash,
		&r.Exp, &r.Level, &r.Status, &r.CreatedAt,
		&r.TitleName, &r.TitleColor,
		&r.TopicCount, &r.LikeReceived,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, false, nil
		}
		return nil, false, err
	}
	return &r, true, nil
}

// SearchRow 是搜索候选项。
type SearchRow struct {
	PublicID        string
	Username        string
	Nickname        string
	AvatarHash      *string
	AvatarSmallHash *string
	Level           int
	Ambiguous       bool
}

// Search 按昵称或登录名的前缀取候选（limit 由调用方夹紧）。
func Search(ctx context.Context, q pgsql.Querier, prefix string, limit int) ([]SearchRow, error) {
	rows, err := q.QueryContext(ctx, SearchSQL, prefix, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SearchRow
	for rows.Next() {
		var r SearchRow
		if err := rows.Scan(&r.PublicID, &r.Username, &r.Nickname,
			&r.AvatarHash, &r.AvatarSmallHash, &r.Level, &r.Ambiguous); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
