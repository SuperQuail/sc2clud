package pgsql

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// TopicRow 是列表项的全部列（d3-forum §3.2 Q1 的 SELECT 列表 + 游标排序键）。
type TopicRow struct {
	ID           int64
	PublicID     string
	Kind         string
	Title        string
	Excerpt      string
	Visibility   string
	ReviewState  string
	ReplyCount   int
	LikeCount    int
	ViewCount    int64
	LastReplyAt  time.Time
	CreatedAt    time.Time
	Pinned       bool
	Featured     bool
	Locked       bool
	BoardSlug    string
	BoardName    string
	Author       UserRow
	CoverHash    *string
	CoverWidth   int
	CoverHeight  int
	BookmarkedAt *time.Time
}

// UserRow 是卡片与楼层上的作者列。
type UserRow struct {
	ID          int64
	PublicID    string
	Handle      string
	Nickname    string
	AvatarHash  *string
	AvatarSmall *string
	Status      string
}

// 封面 = sort = 0 的那张（D5 的 uq_topic_images_sort 保证主题内唯一）。
// LATERAL 只对最终返回的那 20 行执行（Limit 压在 Nested Loop 上方），不会变成 20 次全表扫。
const coverJoin = `
  LEFT JOIN LATERAL (
    SELECT i.hash, i.width, i.height
      FROM topic_images ti JOIN images i ON i.hash = ti.image_hash
     WHERE ti.topic_id = t.id AND ti.sort = 0
  ) ci ON true`

const authorJoin = `
  JOIN users a ON a.id = t.author_id`

const boardJoin = `
  JOIN boards b ON b.id = t.board_id`

// topicColumns 是列表项列清单，顺序即 scanTopicRow 的扫描顺序。
const topicColumns = `t.id, t.public_id, t.kind, t.title, t.excerpt,
       t.visibility, t.review_state,
       t.reply_count, t.like_count, t.view_count, t.last_reply_at, t.created_at,
       (t.pinned_at IS NOT NULL) AS pinned, (t.featured_at IS NOT NULL) AS featured,
       (t.locked_at IS NOT NULL) AS locked,
       b.slug, b.name,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username), a.avatar_hash, a.avatar_small_hash, a.status,
       ci.hash, ci.width, ci.height`

// scanTopicRow 按 topicColumns 的顺序扫一行；extra 按调用方在列清单之后追加的列依次接收。
func scanTopicRow(rows *sql.Rows, r *TopicRow, extra ...any) error {
	var cover, avatar, avatarSmall sql.NullString
	var w, h sql.NullInt64
	dest := []any{
		&r.ID, &r.PublicID, &r.Kind, &r.Title, &r.Excerpt,
		&r.Visibility, &r.ReviewState,
		&r.ReplyCount, &r.LikeCount, &r.ViewCount, &r.LastReplyAt, &r.CreatedAt,
		&r.Pinned, &r.Featured, &r.Locked,
		&r.BoardSlug, &r.BoardName,
		&r.Author.ID, &r.Author.PublicID, &r.Author.Handle, &r.Author.Nickname, &avatar, &avatarSmall, &r.Author.Status,
		&cover, &w, &h,
	}
	if err := rows.Scan(append(dest, extra...)...); err != nil {
		return err
	}
	r.CoverHash = scanNullString(cover)
	if w.Valid {
		r.CoverWidth = int(w.Int64)
	}
	if h.Valid {
		r.CoverHeight = int(h.Int64)
	}
	r.Author.AvatarHash = scanNullString(avatar)
	r.Author.AvatarSmall = scanNullString(avatarSmall)
	return nil
}

// TopicSort 是排序键白名单。**拼进 SQL 的只有这两列之一，永远不拼用户输入**（§3.2）。
type TopicSort string

const (
	SortLatest TopicSort = "latest" // last_reply_at DESC, id DESC（索引 a / b）
	SortNew    TopicSort = "new"    // created_at   DESC, id DESC（索引 c / d）
)

func (s TopicSort) column() string {
	if s == SortNew {
		return "t.created_at"
	}
	return "t.last_reply_at"
}

// TopicFilter 是四条游标列表共用的筛选形状。
type TopicFilter struct {
	BoardID  *int64 // nil = 全站
	Kind     string // 空 = 不限
	AuthorID *int64 // 个人主页
	Sort     TopicSort
	CursorT  time.Time
	CursorID int64
	Limit    int
	ViewerID int64
}

// ListTopics 是首页 / 分区页 / 个人主页的主题列表（§3.2 Q1、§3.3 Q2a/Q2c/Q2d、§3.5 Q4a 的骨架）。
//
// 公开流的可见性只有一条：visibility='normal' AND review_state='approved'。
// 个人主页是另一条：author_id = $1 AND (visibility='normal' OR author_id=$viewer)——
// 作者看得见自己的 pending/rejected，别人的待审帖落掉（§3.5 Q4a 的注）。
func (s *Store) ListTopics(ctx context.Context, f TopicFilter, featured bool) ([]TopicRow, error) {
	col := f.Sort.column()
	var sqlText string
	var args []any

	if f.AuthorID != nil {
		sqlText = "SELECT " + topicColumns + " FROM topics t" + boardJoin + authorJoin + coverJoin +
			" WHERE t.author_id = $1 AND (t.visibility = 'normal' OR t.author_id = $5)" +
			" AND (t.created_at, t.id) < ($2::timestamptz, $3::bigint)" +
			" ORDER BY t.created_at DESC, t.id DESC LIMIT $4"
		args = []any{*f.AuthorID, f.CursorT.UTC(), f.CursorID, f.Limit, f.ViewerID}
	} else if featured {
		// 精华标签：部分索引 (f) 已含 featured_at IS NOT NULL，WHERE 里再写一次是冗余但等价的。
		sqlText = "SELECT " + topicColumns + " FROM topics t" + boardJoin + authorJoin + coverJoin +
			" WHERE t.board_id = $1 AND t.visibility = 'normal' AND t.review_state = 'approved'" +
			" AND t.featured_at IS NOT NULL" +
			" AND (t.featured_at, t.id) < ($3::timestamptz, $4::bigint)" +
			" ORDER BY t.featured_at DESC, t.id DESC LIMIT $5"
		args = []any{f.BoardID, f.CursorT.UTC(), f.CursorID, f.Limit}
	} else {
		sqlText = "SELECT " + topicColumns + " FROM topics t" + boardJoin + authorJoin + coverJoin +
			" WHERE t.visibility = 'normal' AND t.review_state = 'approved'" +
			" AND ($1::bigint IS NULL OR t.board_id = $1)" +
			" AND ($2::text IS NULL OR t.kind = $2)" +
			" AND (" + col + ", t.id) < ($3::timestamptz, $4::bigint)" +
			" ORDER BY " + col + " DESC NULLS LAST, t.id DESC LIMIT $5"
		args = []any{f.BoardID, nullIfEmpty(f.Kind), f.CursorT.UTC(), f.CursorID, f.Limit}
	}

	var out []TopicRow
	err := s.query(ctx, sqlText, args, func(rows *sql.Rows) error {
		var r TopicRow
		if err := scanTopicRow(rows, &r); err != nil {
			return err
		}
		out = append(out, r)
		return nil
	})
	return out, err
}

// ListTopicsByBookmark 是收藏页（§3.6 Q5）：按**收藏时间**倒序，
// 游标是 (bookmarks.created_at, topic_id)——主键 (user_id, topic_id) 保证 topic_id 唯一。
func (s *Store) ListTopicsByBookmark(ctx context.Context, userID int64, cursorT time.Time, cursorID int64, limit int) ([]TopicRow, error) {
	sqlText := "SELECT " + topicColumns + ", bk.created_at" +
		" FROM bookmarks bk JOIN topics t ON t.id = bk.topic_id" + boardJoin + authorJoin + coverJoin +
		" WHERE bk.user_id = $1" +
		" AND (bk.created_at, bk.topic_id) < ($2::timestamptz, $3::bigint)" +
		" AND (t.visibility = 'normal' OR t.author_id = $1)" +
		" ORDER BY bk.created_at DESC, bk.topic_id DESC LIMIT $4"
	var out []TopicRow
	err := s.query(ctx, sqlText, []any{userID, cursorT.UTC(), cursorID, limit}, func(rows *sql.Rows) error {
		var r TopicRow
		var marked time.Time
		if err := scanTopicRow(rows, &r, &marked); err != nil {
			return err
		}
		r.BookmarkedAt = &marked
		out = append(out, r)
		return nil
	})
	return out, err
}

// ListPinned 是置顶区块（§3.3 Q2b）：单独一条查询、不进游标、不翻页。
// 把 pinned_at 放进排序键会让置顶帖在每一页重复出现（§0 结论 3）。
func (s *Store) ListPinned(ctx context.Context, boardID int64) ([]TopicRow, error) {
	sqlText := "SELECT " + topicColumns + " FROM topics t" + boardJoin + authorJoin + coverJoin +
		" WHERE t.board_id = $1 AND t.visibility = 'normal' AND t.pinned_at IS NOT NULL" +
		" ORDER BY t.pinned_at DESC, t.id DESC LIMIT 5"
	var out []TopicRow
	err := s.query(ctx, sqlText, []any{boardID}, func(rows *sql.Rows) error {
		var r TopicRow
		if err := scanTopicRow(rows, &r); err != nil {
			return err
		}
		out = append(out, r)
		return nil
	})
	return out, err
}

// TopicDetailRow 是详情（§3.7 Q6 + Q7a）。
type TopicDetailRow struct {
	TopicRow
	BoardID        int64
	BoardACL       bool
	MinPostLevel   int
	ReviewNote     *string
	ResourceStatus *string
	IssueOpenCount int
	MyVote         int
	Bookmarked     bool
	ContentMD      string
	ContentHTML    string
	ContentDeleted bool
}

// TopicDetail 一条查询拿全：主题 + 作者 + 分区 + 我是否收藏 + 我的投票 + issue 未关闭数 + 1 楼正文。
//
// canSeePending 只在管理端审核详情里为 true；公开详情恒 false。
// 1 楼被软删时内容列仍然返回（floor 不会消失，前端渲染成「正文已被作者删除」）——
// 这就是「正文删了标题还在」的实现方式。
func (s *Store) TopicDetail(ctx context.Context, publicID string, viewerID int64, canSeePending bool) (*TopicDetailRow, error) {
	sqlText := "SELECT " + topicColumns + " " + `,
       t.board_id, b.acl_enabled, b.min_post_level, t.review_note, t.resource_status,
       (SELECT count(*) FROM post_issues i
         WHERE i.topic_id = t.id AND i.status = 'keep_open'),
       COALESCE((SELECT l.value FROM likes l
         WHERE l.user_id = $2 AND l.target_type = 'topic' AND l.target_id = t.id), 0),
       EXISTS (SELECT 1 FROM bookmarks bk WHERE bk.user_id = $2 AND bk.topic_id = t.id),
       COALESCE(p.content_md, ''), COALESCE(p.content_html, ''), COALESCE(p.visibility <> 'normal', false)
  FROM topics t` + boardJoin + authorJoin + coverJoin + `
  LEFT JOIN posts p ON p.topic_id = t.id AND p.floor = 1
 WHERE t.public_id = $1
   AND ( (t.visibility = 'normal' AND t.review_state = 'approved')
         OR t.author_id = $2
         OR $3::boolean )`
	var d *TopicDetailRow
	err := s.query(ctx, sqlText, []any{publicID, viewerID, canSeePending}, func(rows *sql.Rows) error {
		var r TopicDetailRow
		var cover, avatar, avatarSmall sql.NullString
		var w, h sql.NullInt64
		dest := []any{
			&r.ID, &r.PublicID, &r.Kind, &r.Title, &r.Excerpt,
			&r.Visibility, &r.ReviewState,
			&r.ReplyCount, &r.LikeCount, &r.ViewCount, &r.LastReplyAt, &r.CreatedAt,
			&r.Pinned, &r.Featured, &r.Locked,
			&r.BoardSlug, &r.BoardName,
			&r.Author.ID, &r.Author.PublicID, &r.Author.Handle, &r.Author.Nickname, &avatar, &avatarSmall, &r.Author.Status,
			&cover, &w, &h,
		}
		extra := []any{
			&r.BoardID, &r.BoardACL, &r.MinPostLevel, &r.ReviewNote, &r.ResourceStatus,
			&r.IssueOpenCount, &r.MyVote, &r.Bookmarked,
			&r.ContentMD, &r.ContentHTML, &r.ContentDeleted,
		}
		if err := rows.Scan(append(dest, extra...)...); err != nil {
			return err
		}
		r.CoverHash = scanNullString(cover)
		r.Author.AvatarHash = scanNullString(avatar)
		r.Author.AvatarSmall = scanNullString(avatarSmall)
		d = &r
		return nil
	})
	if err != nil {
		return nil, err
	}
	if d == nil {
		return nil, ErrNoRows
	}
	return d, nil
}

// TopicRef 是「先解 id 再干活」的入口，带上判定要用的列。
type TopicRef struct {
	ID          int64
	BoardID     int64
	AuthorID    int64
	Kind        string
	Visibility  string
	ReviewState string
	LockedAt    *time.Time
}

// TopicRef 取主题的判定列，可见性规则与 TopicDetail 同一套。
func (s *Store) TopicRef(ctx context.Context, publicID string, viewerID int64, canSeePending bool) (*TopicRef, error) {
	var r TopicRef
	err := s.queryOne(ctx, `
SELECT id, board_id, author_id, kind, visibility, review_state, locked_at
  FROM topics
 WHERE public_id = $1
   AND ( (visibility = 'normal' AND review_state = 'approved')
         OR author_id = $2
         OR $3::boolean )`,
		[]any{publicID, viewerID, canSeePending}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ID, &r.BoardID, &r.AuthorID, &r.Kind, &r.Visibility, &r.ReviewState, &r.LockedAt)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// TopicRefByID 按内部 id 取同一组判定列（评论路由要先知道主题的锁定状态）。
func (s *Store) TopicRefByID(ctx context.Context, topicID int64) (*TopicRef, error) {
	var r TopicRef
	err := s.queryOne(ctx, `
SELECT id, board_id, author_id, kind, visibility, review_state, locked_at
  FROM topics WHERE id = $1`,
		[]any{topicID}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ID, &r.BoardID, &r.AuthorID, &r.Kind, &r.Visibility, &r.ReviewState, &r.LockedAt)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// TopicRefForUpdate 是发回复 / 发 Issue 前的行锁（§4.4 ①、§7.6 ①）：
// 让同一主题的并发分配 floor 与并发取号串行。锁的是主题行不是 posts：
// floor 的唯一性另有 uq_posts_topic_floor 兜底。
func TopicRefForUpdate(ctx context.Context, tx Querier, topicID int64) (*TopicRef, error) {
	var r TopicRef
	if err := queryOneQ(ctx, tx, `
SELECT id, board_id, author_id, kind, visibility, review_state, locked_at
  FROM topics WHERE id = $1 FOR UPDATE`,
		[]any{topicID}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ID, &r.BoardID, &r.AuthorID, &r.Kind, &r.Visibility, &r.ReviewState, &r.LockedAt)
		}); err != nil {
		return nil, err
	}
	return &r, nil
}

// TopicIDByClientToken 是幂等键撞车后的回查（§4.3）：返回已存在的那一条。
func (s *Store) TopicIDByClientToken(ctx context.Context, authorID int64, token string) (int64, string, error) {
	return topicByClientToken(ctx, s.q, authorID, token)
}

// topicByClientToken 是幂等键撞车后的回查（§4.3）：返回已存在的那一条。
// 先查再插会在并发下两个请求都查到「不存在」然后都插——那正是幂等键要解决的事。
func topicByClientToken(ctx context.Context, q Querier, authorID int64, token string) (int64, string, error) {
	var id int64
	var publicID string
	err := queryOneQ(ctx, q, "SELECT id, public_id FROM topics WHERE author_id = $1 AND client_token = $2",
		[]any{authorID, token}, func(rows *sql.Rows) error {
			return rows.Scan(&id, &publicID)
		})
	return id, publicID, err
}

// TopicCard 用列表项的形状回读一张卡片（发主题后组详情用）。
func (s *Store) TopicCard(ctx context.Context, topicID int64) (*TopicRow, error) {
	sqlText := "SELECT " + topicColumns + " FROM topics t" + boardJoin + authorJoin + coverJoin + " WHERE t.id = $1"
	var out *TopicRow
	err := s.query(ctx, sqlText, []any{topicID}, func(rows *sql.Rows) error {
		var r TopicRow
		if err := scanTopicRow(rows, &r); err != nil {
			return err
		}
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

// ---- 写 ----

// InsertTopic 插主题行（§4.2 ①）。last_reply_at 建主题时就 = now：
// 「没有回复」不是状态，是「最后一条楼层就是 1 楼」，排序键因此永远非空。
func InsertTopic(ctx context.Context, tx Querier, publicID string, boardID, authorID int64,
	kind, title, excerpt, reviewState string, resourceStatus *string, clientToken string, now time.Time) (int64, error) {
	var id int64
	err := queryOneQ(ctx, tx, `
INSERT INTO topics (public_id, board_id, author_id, kind, title, excerpt,
                    review_state, resource_status, client_token,
                    last_reply_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10)
RETURNING id`,
		[]any{publicID, boardID, authorID, kind, title, excerpt, reviewState, resourceStatus, clientToken, now.UTC()},
		func(rows *sql.Rows) error { return rows.Scan(&id) })
	return id, err
}

// UpdateTopicFields 是 PATCH /topics/{id} 的落点：标题 / kind / 分区 / resource_status。
// 换分区时 pinned_at 置空：置顶是「在某个分区置顶」，换了分区就不成立（§4.5）。
func UpdateTopicFields(ctx context.Context, tx Querier, topicID int64, title, kind *string, boardID *int64,
	resourceStatus *string, clearResourceStatus bool, now time.Time) error {
	return exec(ctx, tx, `
UPDATE topics
   SET title           = COALESCE($2, title),
       kind            = COALESCE($3, kind),
       board_id        = COALESCE($4, board_id),
       pinned_at       = CASE WHEN $4::bigint IS NULL THEN pinned_at ELSE NULL END,
       resource_status = CASE WHEN $6::boolean THEN $5 ELSE COALESCE($5, resource_status) END,
       updated_at      = $7
 WHERE id = $1`,
		topicID, title, kind, boardID, resourceStatus, clearResourceStatus, now.UTC())
}

// SetTopicExcerpt 只在编辑 1 楼正文时用（§4.5）：摘要与正文同源。
func SetTopicExcerpt(ctx context.Context, tx Querier, topicID int64, excerpt string, now time.Time) error {
	return exec(ctx, tx, "UPDATE topics SET excerpt = $2, updated_at = $3 WHERE id = $1", topicID, excerpt, now.UTC())
}

// DeleteTopicRows 是删主题（§4.6，一个事务三条语句）：
//   - 主题置 deleted 并清掉置顶 / 精华（ck_topics_deleted_no_pin 要求）；
//   - 全部楼层一起置 deleted（刻意的冗余：任何一条忘了 JOIN topics 的楼层查询都不该漏出去）；
//   - 多态点赞一条语句清掉（likes 没有外键，孤儿行由应用保证清理）。
func DeleteTopicRows(ctx context.Context, tx Querier, topicID int64, now time.Time) error {
	// **一条 Exec 只发一条语句**：pgx 的扩展协议不接受多语句。
	if err := exec(ctx, tx, `
UPDATE topics SET visibility = 'deleted', pinned_at = NULL, featured_at = NULL, updated_at = $2
 WHERE id = $1 AND visibility <> 'deleted'`, topicID, now.UTC()); err != nil {
		return err
	}
	if err := exec(ctx, tx, "UPDATE posts SET visibility = 'deleted', updated_at = $2 WHERE topic_id = $1",
		topicID, now.UTC()); err != nil {
		return err
	}
	return exec(ctx, tx, `
DELETE FROM likes
 WHERE (target_type = 'topic' AND target_id = $1)
    OR (target_type = 'post'  AND target_id IN (SELECT id FROM posts WHERE topic_id = $1))`, topicID)
}

// LockTopic 是幂等的锁定（§4.7）：COALESCE 保证重复锁定不刷新时间戳——
// 那个时间戳是「什么时候锁的」，不是「最后一次有人点锁定」。
func LockTopic(ctx context.Context, tx Querier, topicID int64, locked bool, now time.Time) (bool, error) {
	var lockedAt *time.Time
	err := queryOneQ(ctx, tx, `
UPDATE topics SET locked_at = CASE WHEN $2 THEN COALESCE(locked_at, $3) ELSE NULL END, updated_at = $3
 WHERE id = $1 AND visibility <> 'deleted'
RETURNING locked_at`, []any{topicID, locked, now.UTC()}, func(rows *sql.Rows) error {
		return rows.Scan(&lockedAt)
	})
	if err != nil {
		return false, err
	}
	return lockedAt != nil, nil
}

// PinTopic 是置顶与精华共用的形状（§4.7）。**转载帖不允许置顶**：
// 那是替别人做宣传（产品判断，写成规则）。column 只接受两个常量。
func PinTopic(ctx context.Context, tx Querier, topicID int64, column string, on bool, now time.Time) (bool, error) {
	if column != "pinned_at" && column != "featured_at" {
		return false, fmt.Errorf("pgsql: 未知的置顶列 %q", column)
	}
	var at *time.Time
	err := queryOneQ(ctx, tx, `
UPDATE topics SET `+column+` = CASE WHEN $2 THEN COALESCE(`+column+`, $3) ELSE NULL END, updated_at = $3
 WHERE id = $1 AND visibility <> 'deleted' AND kind <> 'repost'
RETURNING `+column, []any{topicID, on, now.UTC()}, func(rows *sql.Rows) error {
		return rows.Scan(&at)
	})
	if err != nil {
		return false, err
	}
	return at != nil, nil
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// nullIfZero 把「0 = 不过滤」的整型筛选换成 NULL，让条件恒真。
// 它存在的理由：被筛选的参数**必须在 SQL 里恒被引用**（引用了才推断得出类型），
// 所以不能靠「不给筛选就不拼这段条件」来省掉它（issues.go 的 $5 踩过 42P18）。
func nullIfZero(n int64) *int64 {
	if n == 0 {
		return nil
	}
	return &n
}
