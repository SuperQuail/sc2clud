package pgsql

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// IssueRow 是 Issue 的一行（§7.7 Q10 / §7.8 Q11）。
type IssueRow struct {
	ID           int64
	PublicID     string
	Number       int
	Kind         string
	Title        string
	Status       string
	BodyHTML     string
	Tags         []string
	CommentCount int
	CreatedAt    time.Time
	UpdatedAt    time.Time
	ClosedAt     *time.Time
	TopicID      int64
	TopicTitle   string
	BoardSlug    string
	BoardName    string
	Author       UserRow
	Assignee     *UserRow
}

// topicScopeColumns 是「主题只用来限定范围」时的那三列：issues 的两条列表都用它，
// 不要用 topicColumns（那一条还带 boards / users / topic_images 的列，这里没有那些 JOIN）。
const topicScopeColumns = `t.id, t.title, b.slug, b.name`

const issueColumns = "i.id, i.public_id, i.number, i.kind, i.title, i.status, i.body_html, i.tags, " +
	"i.created_at, i.updated_at, i.closed_at, " +
	topicScopeColumns + ", " +
	"a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username), COALESCE(NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), COALESCE(NULLIF(a.avatar_small_hash, ''), NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), a.status"

// 指派人是可空的外键：LEFT JOIN + 一组可空标量，扫完再拼成一个可空的 UserRow。
const issueAssignee = `
       asg.id, asg.public_id, asg.username, COALESCE(NULLIF(asg.nickname, ''), asg.username), COALESCE(NULLIF(asg.avatar_hash, ''), asg.default_avatar_hash, ''), COALESCE(NULLIF(asg.avatar_small_hash, ''), NULLIF(asg.avatar_hash, ''), asg.default_avatar_hash, ''), asg.status`

const issueFrom = `
  FROM post_issues i
  JOIN topics t ON t.id = i.topic_id
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = i.author_id
  LEFT JOIN users asg ON asg.id = i.assignee_id`

// issueCommentCount 是列表项上的评论数（一条相关子查询，走 idx_issue_comments_issue）。
const issueCommentCount = `
       (SELECT count(*) FROM issue_comments c WHERE c.issue_id = i.id AND c.visibility = 'normal')`

func scanIssue(rows *sql.Rows, r *IssueRow, extra ...any) error {
	var avatar, avatarSmall sql.NullString
	var tags string
	dest := []any{
		&r.ID, &r.PublicID, &r.Number, &r.Kind, &r.Title, &r.Status, &r.BodyHTML, &tags,
		&r.CreatedAt, &r.UpdatedAt, &r.ClosedAt,
		&r.TopicID, &r.TopicTitle, &r.BoardSlug, &r.BoardName,
		&r.Author.ID, &r.Author.PublicID, &r.Author.Handle, &r.Author.Nickname, &avatar, &avatarSmall, &r.Author.Status,
	}
	var (
		asgID                                    sql.NullInt64
		asgPublic, asgHandle, asgNick, asgStatus sql.NullString
		asgAvatar, asgAvatarSmall                sql.NullString
	)
	dest = append(dest, &asgID, &asgPublic, &asgHandle, &asgNick, &asgAvatar, &asgAvatarSmall, &asgStatus)
	if err := rows.Scan(append(dest, extra...)...); err != nil {
		return err
	}
	r.Tags = tagsArray(tags)
	r.Author.AvatarHash = scanNullString(avatar)
	r.Author.AvatarSmall = scanNullString(avatarSmall)
	if asgID.Valid {
		r.Assignee = &UserRow{
			ID: asgID.Int64, PublicID: asgPublic.String, Handle: asgHandle.String, Nickname: asgNick.String,
			AvatarHash: scanNullString(asgAvatar), AvatarSmall: scanNullString(asgAvatarSmall), Status: asgStatus.String,
		}
	}
	return nil
}

// tagsArray 解析 Postgres 的 text[] 文本（{a,b}）。标签是后端自己写进去的短词
// （service 已限制字符集），不含引号与逗号，所以不需要通用解析器。
func tagsArray(s string) []string {
	if len(s) < 2 || s[0] != '{' || s[len(s)-1] != '}' {
		return nil
	}
	body := s[1 : len(s)-1]
	if body == "" {
		return nil
	}
	parts := strings.Split(body, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// IssueSort 是排序键白名单（§7.7）。**拼进 SQL 的只有这三列之一。**
type IssueSort string

const (
	IssueSortUpdated  IssueSort = "updated"  // 默认：updated_at DESC, id DESC（走索引 n / o）
	IssueSortCreated  IssueSort = "created"  // created_at DESC, id DESC（索引前缀仍是 status）
	IssueSortComments IssueSort = "comments" // comment_count DESC：**不走索引**，只能在首页用
)

func (s IssueSort) column() string {
	switch s {
	case IssueSortCreated:
		return "i.created_at"
	case IssueSortComments:
		return "comment_count"
	default:
		return "i.updated_at"
	}
}

// IssueFilter 是 Issue 列表的筛选形状。
type IssueFilter struct {
	TopicID    int64  // 0 = 全站聚合
	Status     string // keep_open | closed | 空
	Kind       string
	AuthorID   *int64
	AssigneeID *int64
	Sort       IssueSort
	CursorT    time.Time
	CursorID   int64
	Limit      int
}

// ListIssues 用一条 SQL 服务单帖列表与全站聚合（§7.7 Q10 / §7.8 Q11）：
// 唯一区别是 scope（按可见性 vs 按 topic_id 等值），两条查询各吃
// idx_post_issues_global 与 idx_post_issues_topic_status 的一个前缀。
//
// sort=comments 的排序键是聚合出来的 comment_count，不走索引，所以 service 只允许它出现在
// 首页（无游标）；带上游标直接 400（§7.7 的注）。
func (s *Store) ListIssues(ctx context.Context, f IssueFilter) ([]IssueRow, error) {
	col := f.Sort.column()
	// scope 是**一个恒被引用的条件**，不是「有时拼进来的一整段」：args 里恒有 $5，
	// 只要有一条路径不引用它，pgx 的 DescribeExec 就定不出它的类型 → 42P18
	// （全站列表、无筛选时就是这么炸的）。改这条 SQL 的人请保持「参数个数 == 拼进去的个数」。
	scope := "($5::bigint IS NULL OR i.topic_id = $5)"
	cursor := "(" + col + ", i.id) < ($6::timestamptz, $7::bigint)"
	if f.Sort == IssueSortComments {
		// 首页才允许；带游标由 service 拒掉（所以这里给一个恒真的游标条件是没有意义的，
		// 直接用 id 兜底，保证首页 20 条稳定）。
		cursor = "TRUE"
	}
	order := col + " DESC, i.id DESC"

	sqlText := "SELECT " + issueColumns + "," + issueAssignee + "," + issueCommentCount + issueFrom +
		" WHERE " + scope +
		" AND ($1::text IS NULL OR i.status = $1)" +
		" AND ($2::text IS NULL OR i.kind = $2)" +
		" AND ($3::bigint IS NULL OR i.author_id = $3)" +
		" AND ($4::bigint IS NULL OR i.assignee_id = $4)" +
		" AND " + cursor +
		" ORDER BY " + order + " LIMIT $8"

	// TopicID=0（全站聚合）时给 NULL，条件退化成恒真——$5 仍然被引用。
	args := []any{nullIfEmpty(f.Status), nullIfEmpty(f.Kind), f.AuthorID, f.AssigneeID,
		nullIfZero(f.TopicID), f.CursorT.UTC(), f.CursorID, f.Limit}

	var out []IssueRow
	err := s.query(ctx, sqlText, args, func(rows *sql.Rows) error {
		var r IssueRow
		if err := scanIssue(rows, &r, &r.CommentCount); err != nil {
			return err
		}
		out = append(out, r)
		return nil
	})
	return out, err
}

// IssueRef 是写路径要的判定列。
type IssueRef struct {
	ID         int64
	PublicID   string
	TopicID    int64
	BoardID    int64
	AuthorID   int64
	AssigneeID *int64
	Kind       string
	Status     string
	TopicLive  bool
}

// IssueRef 取一条 Issue。$2 = 当前用户，$3 = 持 post.review（审核队列用，公开详情恒 false）。
func (s *Store) IssueRef(ctx context.Context, publicID string, viewerID int64, canReview bool) (*IssueRef, error) {
	var r IssueRef
	err := s.queryOne(ctx, `
SELECT i.id, i.public_id, i.topic_id, t.board_id, i.author_id, i.assignee_id, i.kind, i.status,
       (t.visibility = 'normal' AND t.review_state = 'approved')
  FROM post_issues i JOIN topics t ON t.id = i.topic_id
 WHERE i.public_id = $1
   AND ( (t.visibility = 'normal' AND t.review_state = 'approved')
         OR t.author_id = $2
         OR $3::boolean )`,
		[]any{publicID, viewerID, canReview}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ID, &r.PublicID, &r.TopicID, &r.BoardID, &r.AuthorID, &r.AssigneeID, &r.Kind, &r.Status, &r.TopicLive)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// IssueIDByClientToken 是幂等回查（§4.3 的同一套办法）。
func (s *Store) IssueIDByClientToken(ctx context.Context, authorID int64, token string) (int64, string, error) {
	return IssueIDByClientToken(ctx, s.q, authorID, token)
}

// IssueIDByClientToken 是幂等回查（§4.3 的同一套办法）。
func IssueIDByClientToken(ctx context.Context, q Querier, authorID int64, token string) (int64, string, error) {
	var id int64
	var publicID string
	err := queryOneQ(ctx, q, "SELECT id, public_id FROM post_issues WHERE author_id = $1 AND client_token = $2",
		[]any{authorID, token}, func(rows *sql.Rows) error {
			return rows.Scan(&id, &publicID)
		})
	return id, publicID, err
}

// CountIssuesByTopic 是详情里的 issue_open_count（拍板 §6 最后一行：不加冗余列）。
// 走 idx_post_issues_topic_status 的 (topic_id, status) 前缀。
func (s *Store) CountIssuesByTopic(ctx context.Context, topicID int64) (int, error) {
	var n int
	err := s.queryOne(ctx, "SELECT count(*) FROM post_issues WHERE topic_id = $1 AND status = 'keep_open'",
		[]any{topicID}, func(rows *sql.Rows) error { return rows.Scan(&n) })
	return n, err
}

// InsertIssue 取号 + 插入（§7.6 ②）。编号从 1 开始，#1 是「这个资源的第一个 bug」——
// 这符合 GitHub 的直觉，而且不会把全站 issue 总量暴露出来。
// uq_post_issues_topic_number 是第二道闸：即使锁判错，重复编号也会被唯一索引拦住。
func InsertIssue(ctx context.Context, tx Querier, publicID string, topicID, authorID int64, kind, title,
	bodyMD, bodyHTML, bodyText, clientToken string, now time.Time) (int64, int, error) {
	var id int64
	var number int
	err := queryOneQ(ctx, tx, sqlJoin(
		"INSERT INTO post_issues (public_id, topic_id, author_id, number, kind, title,",
		"                         body_md, body_html, body_text, client_token, created_at, updated_at)",
		"SELECT $1::uuid, $2::bigint, $3::bigint,",
		"       (COALESCE((SELECT max(number) FROM post_issues WHERE topic_id = $2::bigint), 0) + 1)::int,",
		"       $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::timestamptz, $10::timestamptz",
		"RETURNING id, number",
	), []any{publicID, topicID, authorID, kind, title, bodyMD, bodyHTML, bodyText, clientToken, now.UTC()},
		func(rows *sql.Rows) error { return rows.Scan(&id, &number) })
	return id, number, err
}

// UpdateIssue 是 PATCH /issues/{id}：标题 / 正文 / 开关 / 指派共用一条骨架
// （§7.5：不要写成两条几乎一样的 SQL）。status 由 service 换算成 keep_open|closed，
// closed_by / closed_at 跟着它一起变（ck_post_issues_closed 要求两者同真同假）。
func UpdateIssue(ctx context.Context, tx Querier, issueID int64, title, bodyMD, bodyHTML, bodyText *string,
	status *string, assigneeID *int64, clearAssignee bool, actorID int64, now time.Time) error {
	// 三段各管各的列（一条骨架，参数决定改哪几列）：
	//  标题 / 正文 / 指派：COALESCE —— 没给就保持原值；
	//  开关：只在 status 真的给了、且与现值不同时改写 closed_by / closed_at，
	// 所以「重复点关闭」不刷新时间戳（§7.5）。
	return exec(ctx, tx, sqlJoin(
		"UPDATE post_issues i",
		"   SET title       = COALESCE($2::varchar, i.title),",
		"       body_md     = COALESCE($3::text, i.body_md),",
		"       body_html   = COALESCE($4::text, i.body_html),",
		"       body_text   = COALESCE($5::text, i.body_text),",
		"       status      = CASE WHEN $6::text IS NOT NULL THEN $6::text ELSE i.status END,",
		"       closed_by   = CASE WHEN $6::text = 'closed' AND i.status <> 'closed' THEN $8::bigint",
		"                         WHEN $6::text = 'keep_open' THEN NULL ELSE i.closed_by END,",
		"       closed_at   = CASE WHEN $6::text = 'closed' AND i.status <> 'closed' THEN $9::timestamptz",
		"                         WHEN $6::text = 'keep_open' THEN NULL ELSE i.closed_at END,",
		"       assignee_id = CASE WHEN $10::boolean THEN NULL",
		"                         ELSE COALESCE($7::bigint, i.assignee_id) END,",
		"       updated_at  = $9::timestamptz",
		" WHERE i.id = $1::bigint",
	), issueID, title, bodyMD, bodyHTML, bodyText, status, assigneeID, actorID, now.UTC(), clearAssignee)
}

// IssueComments 是 Issue 的顶层评论一页（§7.8 Q12）。游标按 id，与帖子回复同一套。
// **不做 ?sort=hot**：热排序没有稳定游标，而「最热 / 最新」是同一页数据上的前端排序。
func (s *Store) IssueComments(ctx context.Context, issueID, viewerID, cursorID int64, limit int) ([]IssueCommentRow, error) {
	var out []IssueCommentRow
	err := s.query(ctx, `
SELECT c.id, c.public_id, c.issue_id, c.parent_id, par.public_id, c.body_html, c.visibility,
       c.like_count, c.dislike_count, c.created_at, c.updated_at,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username), COALESCE(NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), COALESCE(NULLIF(a.avatar_small_hash, ''), NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), a.status,
       COALESCE(my.value, 0)
  FROM issue_comments c
  JOIN users a ON a.id = c.author_id
  LEFT JOIN issue_comments par ON par.id = c.parent_id
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'issue_comment' AND my.target_id = c.id
 WHERE c.issue_id = $1 AND c.visibility = 'normal' AND c.parent_id IS NULL
   AND c.id < $3::bigint
 ORDER BY c.id DESC
 LIMIT $4`,
		[]any{issueID, viewerID, cursorID, limit}, func(rows *sql.Rows) error {
			var r IssueCommentRow
			if err := scanIssueComment(rows, &r, &r.MyVote); err != nil {
				return err
			}
			out = append(out, r)
			return nil
		})
	return out, err
}

// IssueCommentReplies 是 Issue 评论的楼中楼（与帖子完全同构，一级、200 条上限）。
func (s *Store) IssueCommentReplies(ctx context.Context, parentID, viewerID int64) ([]IssueCommentRow, error) {
	var out []IssueCommentRow
	err := s.query(ctx, `
SELECT c.id, c.public_id, c.issue_id, c.parent_id, c.body_html, c.visibility,
       c.like_count, c.dislike_count, c.created_at, c.updated_at,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username), COALESCE(NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), COALESCE(NULLIF(a.avatar_small_hash, ''), NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), a.status,
       COALESCE(my.value, 0)
  FROM issue_comments c
  JOIN users a ON a.id = c.author_id
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'issue_comment' AND my.target_id = c.id
 WHERE c.parent_id = $1 AND c.visibility = 'normal'
 ORDER BY c.id
 LIMIT 200`,
		[]any{parentID, viewerID}, func(rows *sql.Rows) error {
			var r IssueCommentRow
			if err := scanIssueComment(rows, &r, &r.MyVote); err != nil {
				return err
			}
			out = append(out, r)
			return nil
		})
	return out, err
}

// IssueCommentRow 是 Issue 评论的一行。
type IssueCommentRow struct {
	ID             int64
	PublicID       string
	IssueID        int64
	ParentID       *int64
	ParentPublicID *string
	BodyHTML       string
	Visibility     string
	LikeCount      int
	DislikeCount   int
	MyVote         int
	CreatedAt      time.Time
	UpdatedAt      time.Time
	Author         UserRow
}

func scanIssueComment(rows *sql.Rows, r *IssueCommentRow, extra ...any) error {
	var avatar, avatarSmall sql.NullString
	dest := []any{
		&r.ID, &r.PublicID, &r.IssueID, &r.ParentID, &r.ParentPublicID, &r.BodyHTML, &r.Visibility,
		&r.LikeCount, &r.DislikeCount, &r.CreatedAt, &r.UpdatedAt,
		&r.Author.ID, &r.Author.PublicID, &r.Author.Handle, &r.Author.Nickname, &avatar, &avatarSmall, &r.Author.Status,
	}
	if err := rows.Scan(append(dest, extra...)...); err != nil {
		return err
	}
	r.Author.AvatarHash = scanNullString(avatar)
	r.Author.AvatarSmall = scanNullString(avatarSmall)
	return nil
}

// IssueCommentRef 是评论写路径的判定列：连它所属 issue 与主题的可见性一起拿。
type IssueCommentRef struct {
	ID         int64
	PublicID   string
	IssueID    int64
	TopicID    int64
	AuthorID   int64
	ParentID   *int64
	Visibility string
}

func (s *Store) IssueCommentRef(ctx context.Context, publicID string, viewerID int64) (*IssueCommentRef, error) {
	var r IssueCommentRef
	err := s.queryOne(ctx, `
SELECT c.id, c.public_id, c.issue_id, i.topic_id, c.author_id, c.parent_id, c.visibility
  FROM issue_comments c
  JOIN post_issues i ON i.id = c.issue_id
  JOIN topics t ON t.id = i.topic_id
 WHERE c.public_id = $1
   AND (c.visibility = 'normal' OR c.author_id = $2)
   AND t.visibility = 'normal' AND t.review_state = 'approved'`,
		[]any{publicID, viewerID}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ID, &r.PublicID, &r.IssueID, &r.TopicID, &r.AuthorID, &r.ParentID, &r.Visibility)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// InsertIssueComment 插一条评论（一级楼中楼由 service 校验 parent）。
func InsertIssueComment(ctx context.Context, tx Querier, publicID string, issueID, authorID int64,
	parentID *int64, bodyMD, bodyHTML string, now time.Time) (int64, error) {
	var id int64
	err := queryOneQ(ctx, tx, `
INSERT INTO issue_comments (public_id, issue_id, author_id, parent_id, body_md, body_html, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
RETURNING id`,
		[]any{publicID, issueID, authorID, parentID, bodyMD, bodyHTML, now.UTC()},
		func(rows *sql.Rows) error { return rows.Scan(&id) })
	return id, err
}

// IssueByID 用列表项的形状回读一张卡片。
func (s *Store) IssueByID(ctx context.Context, issueID int64) (*IssueRow, error) {
	sqlText := "SELECT " + issueColumns + "," + issueAssignee + `,
       (SELECT count(*) FROM issue_comments c WHERE c.issue_id = i.id AND c.visibility = 'normal')
  FROM post_issues i
  JOIN topics t ON t.id = i.topic_id
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = i.author_id
  LEFT JOIN users asg ON asg.id = i.assignee_id
 WHERE i.id = $1`
	var out *IssueRow
	err := s.query(ctx, sqlText, []any{issueID}, func(rows *sql.Rows) error {
		var r IssueRow
		if err := scanIssue(rows, &r, &r.CommentCount); err != nil {
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

// IssueCommentByID 回读一条刚写好的评论（带作者与我的票），用于 201 的响应体。
func (s *Store) IssueCommentByID(ctx context.Context, commentID, viewerID int64) (*IssueCommentRow, error) {
	var out *IssueCommentRow
	err := s.query(ctx, `
SELECT c.id, c.public_id, c.issue_id, c.parent_id, par.public_id, c.body_html, c.visibility,
       c.like_count, c.dislike_count, c.created_at, c.updated_at,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username), COALESCE(NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), COALESCE(NULLIF(a.avatar_small_hash, ''), NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), a.status,
       COALESCE(my.value, 0)
  FROM issue_comments c
  JOIN users a ON a.id = c.author_id
  LEFT JOIN issue_comments par ON par.id = c.parent_id
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'issue_comment' AND my.target_id = c.id
 WHERE c.id = $1`,
		[]any{commentID, viewerID}, func(rows *sql.Rows) error {
			var r IssueCommentRow
			if err := scanIssueComment(rows, &r, &r.MyVote); err != nil {
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
