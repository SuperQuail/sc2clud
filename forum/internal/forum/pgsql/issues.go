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
	IssueSortOld      IssueSort = "old"      // created_at ASC, id ASC：**同一列的另一个方向**
	IssueSortComments IssueSort = "comments" // comment_count DESC：**不走索引**，只能在首页用
)

func (s IssueSort) column() string {
	switch s {
	case IssueSortCreated, IssueSortOld:
		return "i.created_at"
	case IssueSortComments:
		// **就地展开的相关子查询**，不是 SELECT 列表里那个别名 comment_count：
		// 别名在 WHERE / ORDER BY 里看不见（见 ListIssues 的说明）。
		return issueCommentCountExpr
	default:
		return "i.updated_at"
	}
}

// issueCommentCountExpr 是 issueCommentCount 那个别名的**裸表达式**：
// 排序与游标都要在 WHERE / ORDER BY 里直接引用它，而别名在那里不可见。
// 两处逐字同源 —— 改一处必须改另一处。
const issueCommentCountExpr = "(SELECT count(*) FROM issue_comments c WHERE c.issue_id = i.id AND c.visibility = 'normal')"

// ascending 只有 old 一档是 true：方向与游标比较符都要跟着翻，
// 所以它和 column() 必须成对读 —— 单独改一个会让游标静默漏行。
func (s IssueSort) ascending() bool { return s == IssueSortOld }

// IssueFilter 是 Issue 列表的筛选形状。
type IssueFilter struct {
	TopicID int64 // 0 = 全站聚合
	// Q 是标题 + 正文字面匹配（拍板 08 · J5）：**不分词**，所以中文两字词天然命中。
	// 走 ILIKE '%q%'（没有索引可用）—— issue 的量级是「每个资源帖几十条」，
	// 而引入分词器（PG 侧要装扩展、要维护词典）的代价远大于它省下的那点扫描。
	// shortcut: 全表 ILIKE，issue 上百万行时换成 pg_trgm 的 GIN（那才需要扩展）。
	Q          string
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
	// scope 是**一个恒被引用的条件**，不是「有时拼进来的一整段」：args 里恒有 $5，
	// 只要有一条路径不引用它，pgx 的 DescribeExec 就定不出它的类型 → 42P18
	// （全站列表、无筛选时就是这么炸的）。改这条 SQL 的人请保持「参数个数 == 拼进去的个数」。
	scope := "($5::bigint IS NULL OR i.topic_id = $5)"
	// 方向与比较符成对：只有 old 是 ASC（见 IssueSort.ascending 的注释）。
	cmp, dir := "<", "DESC"
	if f.Sort.ascending() {
		cmp, dir = ">", "ASC"
	}
	// **排序键与游标键必须是同一个表达式**，而且都要能在 WHERE / ORDER BY 里直接展开：
	// sort=comments 的键是相关子查询（算出来的数），column() 因此返回裸表达式而不是别名。
	// 不能套一层 `SELECT * FROM (...) q ORDER BY comment_count` —— 外层看不见 i，
	// 而游标条件建立在这个表达式上（第一次实现套了那层，得到 42P01「表 i 丢失 FROM 子句项」）。
	col := f.Sort.column()
	cursor := "(" + col + ", i.id) " + cmp + " ($6::timestamptz, $7::bigint)"
	if f.Sort == IssueSortComments {
		// comments 仍然没有可翻的游标（service 对「带游标」直接 400）；
		// 恒真保证首页 20 条稳定，而不是让它变成一条会扫全表的翻页路径。
		//
		// **必须让 $6/$7 出现在 SQL 里并且带上类型**：pgx 的 DescribeExec 只看得到
		//「参数有没有出现在 SQL 文本里、出现在什么位置」，恒真但完全不含参数的条件
		// 会让它定不出类型 → 42P18「无法确定参数 $6 的数据类型」
		// （这条在补 q / sort=old 的用例之前从来没被跑到：sort=comments 这条路径一次都没测过）。
		// 写法是「参数 IS NOT DISTINCT FROM 它自己」——恒真、类型明确、不依赖任何列。
		cursor = "($6::timestamptz IS NOT DISTINCT FROM $6::timestamptz" +
			" AND $7::bigint IS NOT DISTINCT FROM $7::bigint)"
	}
	order := col + " " + dir + ", i.id " + dir

	sqlText := "SELECT " + issueColumns + "," + issueAssignee + "," + issueCommentCount + issueFrom +
		" WHERE " + scope +
		" AND ($1::text IS NULL OR i.status = $1)" +
		" AND ($2::text IS NULL OR i.kind = $2)" +
		" AND ($3::bigint IS NULL OR i.author_id = $3)" +
		" AND ($4::bigint IS NULL OR i.assignee_id = $4)" +
		" AND ($9::text IS NULL OR i.title ILIKE '%' || $9::text || '%'" +
		"                       OR i.body_text ILIKE '%' || $9::text || '%')" +
		" AND " + cursor +
		" ORDER BY " + order + " LIMIT $8"

	// TopicID=0（全站聚合）时给 NULL，条件退化成恒真——$5 仍然被引用。
	args := []any{nullIfEmpty(f.Status), nullIfEmpty(f.Kind), f.AuthorID, f.AssigneeID,
		nullIfZero(f.TopicID), f.CursorT.UTC(), f.CursorID, f.Limit, nullIfEmpty(f.Q)}

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
	ID       int64
	PublicID string
	TopicID  int64
	BoardID  int64
	// AuthorID 是 **Issue 的发布者**；TopicAuthorID 是它所属主题的作者。
	// 两者不同：J8（拍板 08）要的「能关 Issue 的人 = 作者 / 版主 / 管理员及以上 / Issue 发布者」
	// 里的「作者」指前者、「发布者」指后者 —— 少了任何一列都判不出这四种人。
	AuthorID      int64
	TopicAuthorID int64
	AssigneeID    *int64
	Kind          string
	Status        string
	TopicLive     bool
}

// IssueRef 取一条 Issue。$2 = 当前用户，$3 = 持 post.review（审核队列用，公开详情恒 false）。
func (s *Store) IssueRef(ctx context.Context, publicID string, viewerID int64, canReview bool) (*IssueRef, error) {
	var r IssueRef
	err := s.queryOne(ctx, `
SELECT i.id, i.public_id, i.topic_id, t.board_id, i.author_id, t.author_id, i.assignee_id, i.kind, i.status,
       (t.visibility = 'normal' AND t.review_state = 'approved')
  FROM post_issues i JOIN topics t ON t.id = i.topic_id
 WHERE i.public_id = $1
   AND ( (t.visibility = 'normal' AND t.review_state = 'approved')
         OR t.author_id = $2
         OR $3::boolean )`,
		[]any{publicID, viewerID, canReview}, func(rows *sql.Rows) error {
			return rows.Scan(&r.ID, &r.PublicID, &r.TopicID, &r.BoardID, &r.AuthorID, &r.TopicAuthorID,
				&r.AssigneeID, &r.Kind, &r.Status, &r.TopicLive)
		})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// IssueKindExists 回答「这个 kind 现在存不存在」（拍板 08 · J6：值域由 issue_kinds 表驱动，
// 不是代码里的封闭枚举）。**在发 Issue 的那条事务里查**：
//   - 建 Issue 本来就是个写事务，多一次主键等值查（微秒级）换来「与插入同一快照」的保证；
//   - 缓存要处理失效，而表只在迁移时变 —— 真嫌慢再加缓存，现在不值得多一处会漂的状态。
func (s *Store) IssueKindExists(ctx context.Context, q Querier, kind string) (bool, error) {
	var ok bool
	err := queryOneQ(ctx, q, "SELECT EXISTS (SELECT 1 FROM issue_kinds WHERE key = $1 AND archived = false)",
		[]any{kind}, func(rows *sql.Rows) error { return rows.Scan(&ok) })
	return ok, err
}

// IssueKinds 是当前可用的类型值域（列表筛选与前端入口都用它）。
// 排序键是 sort: 数值小的在前，同值按 key 稳定 —— 有稳定顺序前端才能做深链预设。
func (s *Store) IssueKinds(ctx context.Context) ([]string, error) {
	var out []string
	err := s.query(ctx, "SELECT key FROM issue_kinds WHERE archived = false ORDER BY sort, key",
		nil, func(rows *sql.Rows) error {
			var k string
			if err := rows.Scan(&k); err != nil {
				return err
			}
			out = append(out, k)
			return nil
		})
	return out, err
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
