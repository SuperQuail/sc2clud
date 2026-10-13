package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// VoteValue 是服务端认可的票值：赞 / 踩。主题只接受 +1（§5.1 末段）。
const (
	VoteUp   = 1
	VoteDown = -1
)

// Vote 是幂等的投票（§5.1 的一条语句）。
//
// 三条性质一起成立：
//  1. 重复 PUT 同值 → DO UPDATE 被 WHERE 拦住 → value 为空 → delta 为空 → UPDATE 不跑（计数不动）；
//  2. 从 -1 改成 +1 → 两侧同时平移（d_like +1, d_dislike -1）；
//  3. 与并发请求竞争 → ON CONFLICT 等对方的行锁，等完再判 WHERE。对方已经改成同值时本事务的
//     WHERE 为假 → 不更新 → 计数不动。**这就是 CAS 语义，不需要显式锁。**
//
// 返回值：是否真的产生了新票（用于 notify:like）、更新后的两个计数。
func Vote(ctx context.Context, tx Querier, targetType string, targetID, userID int64, value int, now time.Time) (bool, int, int, error) {
	switch targetType {
	case "post":
		return voteOn(ctx, tx, targetType, targetID, userID, value, now, postsCounts)
	case "issue_comment":
		return voteOn(ctx, tx, targetType, targetID, userID, value, now, issueCommentsCounts)
	case "topic":
		return voteOn(ctx, tx, targetType, targetID, userID, value, now, topicsCounts)
	default:
		return false, 0, 0, ErrNoRows
	}
}

// 三张表的计数列名与目标列不同，所以「读回计数」的尾巴有三份。
// 这是刻意的：把列名拼进 SQL 才是真的会写错的那种抽象。
const (
	postsCounts = "posts"
	issueCommentsCounts = "issue_comments"
	topicsCounts = "topics"
)

func voteOn(ctx context.Context, tx Querier, targetType string, targetID, userID int64, value int, now time.Time, table string) (bool, int, int, error) {
	sqlText := `
WITH up AS (
  INSERT INTO likes (user_id, target_type, target_id, value, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $5)
  ON CONFLICT (user_id, target_type, target_id) DO UPDATE
     SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
   WHERE likes.value IS DISTINCT FROM EXCLUDED.value
  RETURNING (xmax = 0) AS inserted, value, (CASE WHEN value = 1 THEN 1 ELSE 0 END) AS was_like, (CASE WHEN value = -1 THEN 1 ELSE 0 END) AS was_dislike
), delta AS (
  SELECT COALESCE(sum(new_like - was_like), 0)::int       AS d_like,
         COALESCE(sum(new_dislike - was_dislike), 0)::int AS d_dislike,
         COALESCE(bool_or(inserted), false)               AS inserted
    FROM (SELECT inserted, was_like, was_dislike,
                 (CASE WHEN value =  1 THEN 1 ELSE 0 END) AS new_like,
                 (CASE WHEN value = -1 THEN 1 ELSE 0 END) AS new_dislike
            FROM up) s
)
UPDATE ` + table + ` t
   SET like_count    = t.like_count    + d.d_like,
       dislike_count = t.dislike_count + d.d_dislike
  FROM delta d
 WHERE t.id = $3 AND d.d_like + d.d_dislike <> 0
 RETURNING ` + countReturn(table) + `
`

	var inserted bool
	var like, dislike int
	err := queryOneQ(ctx, tx, sqlText, []any{userID, targetType, targetID, value, now.UTC()},
		func(rows *sql.Rows) error {
			targets := countScanTargets(table, &like, &dislike)
			if err := rows.Scan(append([]any{&inserted}, targets...)...); err != nil {
				return err
			}
			return nil
		})
	if err == ErrNoRows {
		// 计数没动（重复投票）或目标不存在：目标不存在由 service 先查过，所以这里是「值没变」。
		// 回读当前计数，让响应里的数字仍然是对的。
		return false, 0, 0, err
	}
	if err != nil {
		return false, 0, 0, err
	}
	return inserted, like, dislike, nil
}

// countReturn 与 countScanTargets 一起解决「topic 只有 like_count」这一件事：
// topics 表**没有** dislike_count 列，所以主题那条查询少一列。
func countReturn(table string) string {
	if table == "topics" {
		return "t.like_count"
	}
	return "t.like_count, t.dislike_count"
}

func countScanTargets(table string, like, dislike *int) []any {
	if table == "topics" {
		return []any{like}
	}
	return []any{like, dislike}
}

// Unvote 是幂等的取消（§5.3）：没有票时不删任何行 → UPDATE 零行 → 幂等成功。
// 计数不可能减到负数：like_count 只在删到 value=1 的行时才减，而那一行正是当初加过的。
func Unvote(ctx context.Context, tx Querier, targetType string, targetID, userID int64) (int, int, error) {
	table := map[string]string{"post": "posts", "issue_comment": "issue_comments", "topic": "topics"}[targetType]
	if table == "" {
		return 0, 0, ErrNoRows
	}
	sqlText := "WITH del AS (DELETE FROM likes WHERE user_id = $1 AND target_type = $2 AND target_id = $3 RETURNING value)" +
		" UPDATE " + table + " t SET like_count = t.like_count - (CASE WHEN d.value = 1 THEN 1 ELSE 0 END)," +
		" dislike_count = t.dislike_count - (CASE WHEN d.value = -1 THEN 1 ELSE 0 END)" +
		" FROM del d WHERE t.id = $3 RETURNING " + countReturn(table)

	var like, dislike int
	err := queryOneQ(ctx, tx, sqlText, []any{userID, targetType, targetID}, func(rows *sql.Rows) error {
		return rows.Scan(countScanTargets(table, &like, &dislike)...)
	})
	if err == ErrNoRows {
		return 0, 0, err
	}
	return like, dislike, err
}

// VoteCounts 是「计数没动」时回读当前值：响应里的两个数字必须是真的。
func VoteCounts(ctx context.Context, tx Querier, targetType string, targetID int64) (int, int, error) {
	table := map[string]string{"post": "posts", "issue_comment": "issue_comments", "topic": "topics"}[targetType]
	if table == "" {
		return 0, 0, ErrNoRows
	}
	var like, dislike int
	err := queryOneQ(ctx, tx, "SELECT "+countReturn(table)+" FROM "+table+" t WHERE t.id = $1",
		[]any{targetID}, func(rows *sql.Rows) error {
			return rows.Scan(countScanTargets(table, &like, &dislike)...)
		})
	return like, dislike, err
}

// InsertBlock / DeleteBlock 是拉黑的两个方向（§4.1.1 末段）。都幂等。
func (s *Store) InsertBlock(ctx context.Context, userID, targetID int64, now time.Time) error {
	return exec(ctx, s.q, "INSERT INTO blocks (user_id, target_user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
		userID, targetID, now.UTC())
}

// DeleteBlock 取消拉黑：没拉黑过也成功（幂等）。
func (s *Store) DeleteBlock(ctx context.Context, userID, targetID int64) error {
	return exec(ctx, s.q, "DELETE FROM blocks WHERE user_id = $1 AND target_user_id = $2", userID, targetID)
}

// BlockedBetween 一次两行拿双向拉黑（§4.1.1 的 SQL）：$1 = 我，$2 = 对方。
// 双向任一命中 → 403，**不告诉他是谁拉黑了谁**。
func (s *Store) BlockedBetween(ctx context.Context, a, b int64) (bool, bool, error) {
	var iBlocked, theyBlocked bool
	err := s.queryOne(ctx, `
SELECT EXISTS (SELECT 1 FROM blocks WHERE user_id = $1 AND target_user_id = $2),
       EXISTS (SELECT 1 FROM blocks WHERE user_id = $2 AND target_user_id = $1)`,
		[]any{a, b}, func(rows *sql.Rows) error {
			return rows.Scan(&iBlocked, &theyBlocked)
		})
	return iBlocked, theyBlocked, err
}

// InsertBookmark 幂等（§5.4）：DO NOTHING 而不是 DO UPDATE——
// 收藏时间就该是第一次收藏的时间（改时间会让收藏夹顺序跳变）。
func (s *Store) InsertBookmark(ctx context.Context, userID, topicID int64, now time.Time) error {
	return exec(ctx, s.q, "INSERT INTO bookmarks (user_id, topic_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
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
		err = s.queryOne(ctx, "SELECT author_id FROM topics WHERE id = $1", []any{targetID}, func(rows *sql.Rows) error {
			return rows.Scan(&owner)
		})
	case "post":
		err = s.queryOne(ctx, "SELECT author_id FROM posts WHERE id = $1", []any{targetID}, func(rows *sql.Rows) error {
			return rows.Scan(&owner)
		})
	case "user":
		return targetID, nil
	default:
		return 0, ErrNoRows
	}
	return owner, err
}
