package pgsql

import (
	"context"
	"database/sql"
	"time"
)

// PostRow 是一个楼层（含作者与我自己的票）。topic_id 是内部 id，用来做归属判定与计数。
type PostRow struct {
	ID             int64
	PublicID       string
	TopicID        int64
	ParentID       *int64
	ParentPublicID *string // 楼中楼才有：parent_id 的内部 id 不出 API，这里换回 public_id
	Floor          int
	ContentHTML    string
	Visibility     string
	LikeCount      int
	DislikeCount   int
	ReplyTotal     int
	MyVote         int
	PreviewIDs     []string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	Author         UserRow
}

const postColumns = `p.id, p.public_id, p.topic_id, p.parent_id, par.public_id, p.floor, p.content_html,
       p.visibility, p.like_count, p.dislike_count, p.created_at, p.updated_at,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username), a.avatar_hash, a.avatar_small_hash, a.status`

func scanPost(rows *sql.Rows, p *PostRow, extra ...any) error {
	var avatar, avatarSmall sql.NullString
	dest := []any{
		&p.ID, &p.PublicID, &p.TopicID, &p.ParentID, &p.ParentPublicID, &p.Floor, &p.ContentHTML,
		&p.Visibility, &p.LikeCount, &p.DislikeCount, &p.CreatedAt, &p.UpdatedAt,
		&p.Author.ID, &p.Author.PublicID, &p.Author.Handle, &p.Author.Nickname, &avatar, &avatarSmall, &p.Author.Status,
	}
	if err := rows.Scan(append(dest, extra...)...); err != nil {
		return err
	}
	p.Author.AvatarHash = scanNullString(avatar)
	p.Author.AvatarSmall = scanNullString(avatarSmall)
	return nil
}

// topLevelReplies 是顶层回复的一页（§3.4 Q3a）。
//
// 排序键是 p.id 而不是 created_at：id 是 identity，与 created_at 同序，但它是单列——
// 游标只装一个整数；而 created_at 由 now() 写入，同一毫秒内两条回复会出现真并列（identity 不会）。
//
// 可见性：楼层跟随主题，没有第二根轴；例外是作者本人能看见自己被隐藏 / 软删的楼层
// （他自己得知道自己删了什么）。主题本身不可见时本端点整条拒绝，不在这里再判一次主题状态。
func (s *Store) TopLevelReplies(ctx context.Context, topicID, viewerID, cursorID int64, limit int) ([]PostRow, error) {
	sqlText := `
WITH roots AS (
  SELECT p.id, p.public_id, p.topic_id, p.parent_id, p.floor, p.content_html,
         p.visibility, p.like_count, p.dislike_count, p.created_at, p.updated_at, p.author_id,
         (SELECT count(*) FROM posts r
           WHERE r.parent_id = p.id AND r.visibility = 'normal') AS reply_total
    FROM posts p
   WHERE p.topic_id = $1
     AND p.parent_id IS NULL
     AND (p.visibility = 'normal' OR p.author_id = $2)
     AND p.id < $3::bigint
   ORDER BY p.id DESC
   LIMIT $4
)
SELECT r.id, r.public_id, r.topic_id, r.parent_id, par.public_id, r.floor, r.content_html,
       r.visibility, r.like_count, r.dislike_count, r.created_at, r.updated_at,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username), a.avatar_hash, a.avatar_small_hash, a.status,
       r.reply_total,
       COALESCE(preview.ids, ARRAY[]::uuid[]) AS preview_ids,
       COALESCE(my.value, 0) AS my_vote
  FROM roots r
  JOIN users a ON a.id = r.author_id
  LEFT JOIN posts par ON par.id = r.parent_id
  LEFT JOIN LATERAL (
    SELECT array_agg(x.public_id ORDER BY x.id) AS ids
      FROM (SELECT q.id, q.public_id FROM posts q
             WHERE q.parent_id = r.id AND q.visibility = 'normal'
             ORDER BY q.id LIMIT 3) x
  ) preview ON true
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'post' AND my.target_id = r.id
 ORDER BY r.id DESC`

	var out []PostRow
	err := s.query(ctx, sqlText, []any{topicID, viewerID, cursorID, limit}, func(rows *sql.Rows) error {
		var r PostRow
		var arr sql.NullString
		if err := scanPost(rows, &r, &r.ReplyTotal, &arr, &r.MyVote); err != nil {
			return err
		}
		r.PreviewIDs = uuidArray(arr.String)
		out = append(out, r)
		return nil
	})
	return out, err
}

// Replies 是某个顶层回复的楼中楼（§3.4 Q3b）。**一级楼中楼，200 条是硬上限**
// （超出说明该帖该改「查看更多」了）。
func (s *Store) Replies(ctx context.Context, parentID, viewerID int64) ([]PostRow, error) {
	sqlText := `SELECT ` + postColumns + `,
       COALESCE(my.value, 0)
  FROM posts p
  JOIN users a ON a.id = p.author_id
  LEFT JOIN posts par ON par.id = p.parent_id
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'post' AND my.target_id = p.id
 WHERE p.parent_id = $1 AND p.visibility = 'normal'
 ORDER BY p.id
 LIMIT 200`
	var out []PostRow
	err := s.query(ctx, sqlText, []any{parentID, viewerID}, func(rows *sql.Rows) error {
		var r PostRow
		if err := scanPost(rows, &r, &r.MyVote); err != nil {
			return err
		}
		out = append(out, r)
		return nil
	})
	return out, err
}

// PostRef 是「先解 id 再干活」的入口。
type PostRef struct {
	ID         int64
	PublicID   string
	TopicID    int64
	BoardID    int64
	AuthorID   int64
	ParentID   *int64
	Floor      int
	Visibility string
	TopicLive  bool // 主题是否对普通读者可见（visibility normal + approved）
}

// PostRef 取楼层的判定列。$2 = 当前用户，$3 = 持 post.review。
// 楼层被隐藏 / 软删时：作者本人与持审核权限的人仍然看得到，别人拿不到（对外是 404）。
func (s *Store) PostRef(ctx context.Context, publicID string, viewerID int64, canReview bool) (*PostRef, error) {
	var r PostRef
	err := s.queryOne(ctx, `
SELECT p.id, p.public_id, p.topic_id, t.board_id, p.author_id, p.parent_id, p.floor, p.visibility,
       (t.visibility = 'normal' AND t.review_state = 'approved') AS topic_live
  FROM posts p JOIN topics t ON t.id = p.topic_id
 WHERE p.public_id = $1
   AND (p.visibility = 'normal' OR p.author_id = $2 OR $3::boolean)`,
		[]any{publicID, viewerID, canReview}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ID, &r.PublicID, &r.TopicID, &r.BoardID, &r.AuthorID, &r.ParentID, &r.Floor, &r.Visibility, &r.TopicLive)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// PostRefByID 按内部 id 再取一份（插入后用，不再走一次可见性判定）。
func (s *Store) PostRefByID(ctx context.Context, postID int64) (*PostRef, error) {
	var r PostRef
	err := s.queryOne(ctx, `
SELECT p.id, p.public_id, p.topic_id, t.board_id, p.author_id, p.parent_id, p.floor, p.visibility,
       (t.visibility = 'normal' AND t.review_state = 'approved')
  FROM posts p JOIN topics t ON t.id = p.topic_id
 WHERE p.id = $1`, []any{postID}, func(rows *sql.Rows) error {
		return rows.Scan(&r.ID, &r.PublicID, &r.TopicID, &r.BoardID, &r.AuthorID, &r.ParentID, &r.Floor, &r.Visibility, &r.TopicLive)
	})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// PostIDByClientToken 是回复的幂等回查（§4.3）。
func (s *Store) PostIDByClientToken(ctx context.Context, authorID int64, token string) (int64, string, error) {
	return PostIDByClientToken(ctx, s.q, authorID, token)
}

// PostIDByClientToken 是回复的幂等回查（§4.3）。
func PostIDByClientToken(ctx context.Context, q Querier, authorID int64, token string) (int64, string, error) {
	var id int64
	var publicID string
	err := queryOneQ(ctx, q, "SELECT id, public_id FROM posts WHERE author_id = $1 AND client_token = $2",
		[]any{authorID, token}, func(rows *sql.Rows) error {
			return rows.Scan(&id, &publicID)
		})
	return id, publicID, err
}

// InsertPost 分配 floor 并插入（§4.4 ②）。
// COALESCE(max(floor),0)+1 在主题行 FOR UPDATE 的保护下是安全的：并发第二条会等到提交后
// 重新读到新的 max。即使这里判错，uq_posts_topic_floor 也会让第二条报唯一冲突。
func InsertPost(ctx context.Context, tx Querier, publicID string, topicID, authorID int64, parentID *int64,
	contentMD, contentHTML, clientToken string, now time.Time) (int64, int, error) {
	var id int64
	var floor int
	err := queryOneQ(ctx, tx, `
INSERT INTO posts (public_id, topic_id, author_id, parent_id, floor,
                   content_md, content_html, client_token, created_at, updated_at)
SELECT $1::uuid, $2::bigint, $3::bigint, $4::bigint,
       COALESCE((SELECT max(floor) FROM posts WHERE topic_id = $2::bigint), 0) + 1,
       $5::text, $6::text, $7::varchar, $8::timestamptz, $8::timestamptz
RETURNING id, floor`,
		[]any{publicID, topicID, authorID, parentID, contentMD, contentHTML, clientToken, now.UTC()},
		func(rows *sql.Rows) error { return rows.Scan(&id, &floor) })
	return id, floor, err
}

// InsertTopicBody 是发主题时的 1 楼（§4.2 ②）：floor 恒为 1，不参与 max+1 的取号。
func InsertTopicBody(ctx context.Context, tx Querier, publicID string, topicID, authorID int64,
	contentMD, contentHTML string, now time.Time) (int64, error) {
	var id int64
	err := queryOneQ(ctx, tx, `
INSERT INTO posts (public_id, topic_id, author_id, floor, content_md, content_html, created_at, updated_at)
VALUES ($1, $2, $3, 1, $4, $5, $6, $6)
RETURNING id`,
		[]any{publicID, topicID, authorID, contentMD, contentHTML, now.UTC()},
		func(rows *sql.Rows) error { return rows.Scan(&id) })
	return id, err
}

// UpdatePostContent 是 PATCH /posts/{id}：正文换了，updated_at 前进；
// **不动 last_reply_at**——编辑不是回复（§4.5）。
func UpdatePostContent(ctx context.Context, tx Querier, postID int64, contentMD, contentHTML string, now time.Time) error {
	return exec(ctx, tx, "UPDATE posts SET content_md = $2, content_html = $3, updated_at = $4 WHERE id = $1",
		postID, contentMD, contentHTML, now.UTC())
}

// RecountTopic 重算 reply_count 与 last_reply_at（§3.7 Q8a/Q8b）。
//
// **刻意不用 reply_count = reply_count + 1**：增量加要在「删回复、删主题、隐藏回复、管理员删楼」
// 四条路径上各写一遍补偿，一处漏写就永久漂移；重算只有一处，且天然收敛。
//
// last_reply_at 的 COALESCE 兜底是给「只剩 1 楼」准备的：1 楼必然存在（不会物理删除），
// 所以它命中的其实就是 t.created_at——那正是「最后一条楼层就是 1 楼」该有的值，
// NOT NULL 因此不会在这一步被破坏。
func RecountTopic(ctx context.Context, tx Querier, topicID int64) error {
	return exec(ctx, tx, `
UPDATE topics t
   SET reply_count  = (SELECT count(*) FROM posts p
                        WHERE p.topic_id = t.id AND p.floor > 1 AND p.visibility = 'normal'),
       last_reply_at = COALESCE((SELECT max(p.created_at) FROM posts p
                                  WHERE p.topic_id = t.id AND p.visibility = 'normal'),
                                t.created_at)
 WHERE t.id = $1`, topicID)
}

// DeletePostRow 是删楼层（§4.6）：只软删楼层本身，主题行不动（1 楼也是这条）。
// 该楼层的票一并删掉——多态表没有外键，孤儿行必须由应用清理。
func DeletePostRow(ctx context.Context, tx Querier, postID int64, now time.Time) error {
	// 一条 Exec 一条语句：pgx 的扩展协议不接受多语句。
	if err := exec(ctx, tx, "UPDATE posts SET visibility = 'deleted', updated_at = $2 WHERE id = $1",
		postID, now.UTC()); err != nil {
		return err
	}
	// 多态表没有外键：这一行的票必须由应用清掉，否则变成孤儿行。
	return exec(ctx, tx, "DELETE FROM likes WHERE target_type = 'post' AND target_id = $1", postID)
}

// PostByID 回读一条楼层（带父楼 public_id、楼中楼条数与前 3 条预览、我的票）：
// 发回复的 201 用它组响应，形状与列表项逐字同源。
func (s *Store) PostByID(ctx context.Context, postID, viewerID int64) (*PostRow, error) {
	var out *PostRow
	err := s.query(ctx, `
SELECT `+postColumns+`,
       (SELECT count(*) FROM posts r WHERE r.parent_id = p.id AND r.visibility = 'normal'),
       COALESCE(preview.ids, ARRAY[]::uuid[]),
       COALESCE(my.value, 0)
  FROM posts p
  JOIN users a ON a.id = p.author_id
  LEFT JOIN posts par ON par.id = p.parent_id
  LEFT JOIN LATERAL (
    SELECT array_agg(x.public_id ORDER BY x.id) AS ids
      FROM (SELECT q.id, q.public_id FROM posts q
             WHERE q.parent_id = p.id AND q.visibility = 'normal'
             ORDER BY q.id LIMIT 3) x
  ) preview ON true
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'post' AND my.target_id = p.id
 WHERE p.id = $1`,
		[]any{postID, viewerID}, func(rows *sql.Rows) error {
			var r PostRow
			var arr sql.NullString
			if err := scanPost(rows, &r, &r.ReplyTotal, &arr, &r.MyVote); err != nil {
				return err
			}
			r.PreviewIDs = uuidArray(arr.String)
			out = &r
			return nil
		})
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, ErrNoRows
	}
	return out, nil
}

// PostIDByFloor 取主题的 1 楼（编辑正文时要用它的 id）。
func (s *Store) PostIDByFloor(ctx context.Context, topicID int64, floor int) (int64, error) {
	var id int64
	err := s.queryOne(ctx, "SELECT id FROM posts WHERE topic_id = $1 AND floor = $2", []any{topicID, floor},
		func(rows *sql.Rows) error { return rows.Scan(&id) })
	return id, err
}
