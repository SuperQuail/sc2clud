package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// Vote 是幂等的投票（d3-forum §5.1 的一条语句）。
//
// 三条性质一起成立：
//  1. 重复 PUT 同值 → DO UPDATE 被 WHERE 拦住 → up 为空 → delta 为空 → UPDATE 不跑（计数不动）；
//  2. 从 -1 改成 +1 → 两侧同时平移（d_like +1, d_dislike -1）；
//  3. 与并发请求竞争 → ON CONFLICT 等对方的行锁，等完再判 WHERE。对方已经改成同值时本事务的
//     WHERE 为假 → 不更新 → 计数不动。**这就是 CAS 语义，不需要显式锁。**
//
// 返回：这一票是否真的改了计数（用于 notify:like 与「计数没动」的判定）。
func Vote(ctx context.Context, tx Querier, targetType string, targetID, userID int64, value int, now time.Time) (bool, error) {
	table, ok := voteTable(targetType)
	if !ok {
		return false, ErrNoRows
	}
	changed := false
	// 0 行 = 这一票与原来相同（幂等重放）：不是错误，计数不动。
	err := queryOneQ(ctx, tx, voteSQL(table), []any{userID, targetType, targetID, value, now.UTC()},
		func(rows *sql.Rows) error { return rows.Scan(&changed) })
	if err == ErrNoRows {
		return false, nil
	}
	return changed, err
}

// voteSQL 按目标表拼出那一条语句。票数落在哪两列上由目标表决定：
// topics 只有 like_count（主题只有赞，没有踩）。
func voteSQL(table string) string {
	return sqlJoin(
		"WITH ins AS (",
		"  INSERT INTO likes (user_id, target_type, target_id, value, created_at, updated_at)",
		"  SELECT $1::bigint, $2::text, $3::bigint, $4::smallint, $5::timestamptz, $5::timestamptz",
		"   WHERE NOT EXISTS (",
		"     SELECT 1 FROM likes p",
		"      WHERE p.user_id = $1::bigint AND p.target_type = $2::text AND p.target_id = $3::bigint",
		"        AND p.value IS NOT DISTINCT FROM $4::smallint)",
		"  ON CONFLICT (user_id, target_type, target_id) DO UPDATE",
		"     SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
		"   WHERE likes.value IS DISTINCT FROM EXCLUDED.value",
		"  RETURNING value AS new_value,",
		"            (CASE WHEN xmax = 0 THEN 0::smallint ELSE (SELECT p.value FROM likes p",
		"               WHERE p.user_id = $1::bigint AND p.target_type = $2::text AND p.target_id = $3::bigint) END) AS old_value",
		")",
		"UPDATE "+table+" t",
		"   SET like_count    = t.like_count    + ((i.new_value =  1)::int - (i.old_value =  1)::int),",
		"       dislike_count = t.dislike_count + ((i.new_value = -1)::int - (i.old_value = -1)::int)",
		"  FROM ins i",
		" WHERE t.id = $3::bigint",
		"   AND i.new_value IS DISTINCT FROM i.old_value",
		" RETURNING true",
	)
}

// Unvote 是幂等的取消（§5.3）：没有票时不删任何行 → UPDATE 零行 → 幂等成功。
// 计数不可能减到负数：like_count 只在删到 value=1 的行时才减，而那一行正是当初加过的。
func (s *Store) Unvote(ctx context.Context, tx Querier, targetType string, targetID, userID int64) (int, int, error) {
	table, ok := voteTable(targetType)
	if !ok {
		return 0, 0, ErrNoRows
	}
	sqlText := sqlJoin(
		"WITH del AS (",
		"  DELETE FROM likes",
		"   WHERE user_id = $1 AND target_type = $2 AND target_id = $3",
		"  RETURNING value",
		")",
		"UPDATE "+table+" t",
		"   SET like_count    = t.like_count    - (CASE WHEN d.value =  1 THEN 1 ELSE 0 END),",
		"       dislike_count = t.dislike_count - (CASE WHEN d.value = -1 THEN 1 ELSE 0 END)",
		"  FROM del d",
		" WHERE t.id = $3",
		" RETURNING " + voteCountCols(table),
	)
	var like, dislike int
	dest := voteCountDest(table, &like, &dislike)
	err := queryOneQ(ctx, tx, sqlText, []any{userID, targetType, targetID},
		func(rows *sql.Rows) error { return rows.Scan(dest...) })
	if err == ErrNoRows {
		// 没有票：删 0 行是成功（幂等），计数不变。回读当前值给响应。
		return 0, 0, ErrNoRows
	}
	return like, dislike, err
}

// voteCountCols 与 voteCountDest 一起解决「topics 只有 like_count」这一件事。
func voteCountCols(table string) string {
	if table == "topics" {
		return "t.like_count"
	}
	return "t.like_count, t.dislike_count"
}

func voteCountDest(table string, like, dislike *int) []any {
	if table == "topics" {
		return []any{like}
	}
	return []any{like, dislike}
}

// VoteCounts 回读当前计数：幂等重放（计数没动）时响应里的数字仍然必须是真的。
// 写路径上 q 传 *ent.Tx（要在同一个事务里读），读路径传 s.q。
func (s *Store) VoteCounts(ctx context.Context, q Querier, targetType string, targetID int64) (int, int, error) {
	table, ok := voteTable(targetType)
	if !ok {
		return 0, 0, ErrNoRows
	}
	var like int
	var dislike int
	cols := "t.like_count, t.dislike_count"
	dest := []any{&like, &dislike}
	if table == "topics" {
		cols = "t.like_count"
		dest = []any{&like}
	}
	err := queryOneQ(ctx, q, "SELECT "+cols+" FROM "+table+" t WHERE t.id = $1::bigint", []any{targetID},
		func(rows *sql.Rows) error { return rows.Scan(dest...) })
	return like, dislike, err
}

func voteTable(targetType string) (string, bool) {
	switch targetType {
	case "post":
		return "posts", true
	case "issue_comment":
		return "issue_comments", true
	case "topic":
		return "topics", true
	default:
		return "", false
	}
}

// InsertBlock / DeleteBlock 是拉黑的两个方向（§4.1.1 末段）。都幂等。
func (s *Store) InsertBlock(ctx context.Context, userID, targetID int64, now time.Time) error {
	return exec(ctx, s.q,
		"INSERT INTO blocks (user_id, target_user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
		userID, targetID, now.UTC())
}

// DeleteBlock 取消拉黑：没拉黑过也成功（幂等）。
func (s *Store) DeleteBlock(ctx context.Context, userID, targetID int64) error {
	return exec(ctx, s.q, "DELETE FROM blocks WHERE user_id = $1 AND target_user_id = $2", userID, targetID)
}

// BlockedBetween 一次两行拿双向拉黑：$1 = 我，$2 = 对方。
// 双向任一命中 → 403，**不告诉他是谁拉黑了谁**。
func (s *Store) BlockedBetween(ctx context.Context, a, b int64) (bool, bool, error) {
	var iBlocked, theyBlocked bool
	err := s.queryOne(ctx, sqlJoin(
		"SELECT EXISTS (SELECT 1 FROM blocks WHERE user_id = $1 AND target_user_id = $2),",
		"       EXISTS (SELECT 1 FROM blocks WHERE user_id = $2 AND target_user_id = $1)",
	), []any{a, b}, func(rows *sql.Rows) error {
		return rows.Scan(&iBlocked, &theyBlocked)
	})
	return iBlocked, theyBlocked, err
}

// InsertBookmark 幂等（§5.4）：DO NOTHING 而不是 DO UPDATE——
// 收藏时间就该是第一次收藏的时间（改时间会让收藏夹顺序跳变）。
func (s *Store) InsertBookmark(ctx context.Context, userID, topicID int64, now time.Time) error {
	return exec(ctx, s.q,
		"INSERT INTO bookmarks (user_id, topic_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
		userID, topicID, now.UTC())
}

// DeleteBookmark 取消收藏：未收藏时删 0 行也是成功（幂等）。
func (s *Store) DeleteBookmark(ctx context.Context, userID, topicID int64) error {
	return exec(ctx, s.q, "DELETE FROM bookmarks WHERE user_id = $1 AND topic_id = $2", userID, topicID)
}

// TargetOwner 是 reports（D6）要的归属解析：target_type + target_id → 作者 id。
// 本域只提供这一件事，reports 表属 D6。
func (s *Store) TargetOwner(ctx context.Context, targetType string, targetID int64) (int64, error) {
	var owner int64
	var err error
	switch targetType {
	case "topic":
		err = s.queryOne(ctx, "SELECT author_id FROM topics WHERE id = $1", []any{targetID},
			func(rows *sql.Rows) error { return rows.Scan(&owner) })
	case "post":
		err = s.queryOne(ctx, "SELECT author_id FROM posts WHERE id = $1", []any{targetID},
			func(rows *sql.Rows) error { return rows.Scan(&owner) })
	case "user":
		return targetID, nil
	default:
		return 0, ErrNoRows
	}
	return owner, err
}
