package pgsql

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// TopicRow 是列表项的全部列（d3-forum §3.2 Q1 的 SELECT 列表 + 游标排序键）。
type TopicRow struct {
	ID          int64
	PublicID    string
	Kind        string
	Title       string
	Excerpt     string
	Visibility  string
	ReviewState string
	ReplyCount  int
	LikeCount   int
	ViewCount   int64
	LastReplyAt time.Time
	CreatedAt   time.Time
	// UpdatedAt 是**编辑时间**（盲测发现详情接口一直返回 Go 零值 —— 列清单里根本没选它）。
	UpdatedAt    time.Time
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
	// HotKey 只有 sort=hot 的那条查询会填（SELECT 列表末尾多的 hot_key 列）：
	// 游标要把它原样带回给客户端，所以扫描时就得接住 —— 见 scanTopicRow 的 extra。
	HotKey float64
}

// UserRow 是卡片与楼层上的作者列。
//
// RoleKey / RoleName / RoleBadgeColor 是**可选**的三列（users.role_id → roles）：
// 只有主题详情那条查询选它们（拍板 08 §第三轮 3 的角色徽标），别的六条作者查询不选 ——
// 所以它们是 *string，nil 就是「这条路径没查角色」，不是「这个人没有角色」。
// users.role_id 是 NOT NULL，查了就不可能是 NULL（除 NULLIF 掉空串的情况）。
type UserRow struct {
	ID             int64
	PublicID       string
	Handle         string
	Nickname       string
	AvatarHash     *string
	AvatarSmall    *string
	Status         string
	RoleKey        *string
	RoleName       *string
	RoleBadgeColor *string
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
       t.reply_count, t.like_count, t.view_count, t.last_reply_at, t.created_at, t.updated_at,
       (t.pinned_at IS NOT NULL) AS pinned, (t.featured_at IS NOT NULL) AS featured,
       (t.locked_at IS NOT NULL) AS locked,
       b.slug, b.name,
       a.id, a.public_id, a.username, COALESCE(NULLIF(a.nickname, ''), a.username), COALESCE(NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), COALESCE(NULLIF(a.avatar_small_hash, ''), NULLIF(a.avatar_hash, ''), a.default_avatar_hash, ''), a.status,
       ci.hash, ci.width, ci.height`

// scanTopicRow 按 topicColumns 的顺序扫一行；extra 按调用方在列清单之后追加的列依次接收。
func scanTopicRow(rows *sql.Rows, r *TopicRow, extra ...any) error {
	var cover, avatar, avatarSmall sql.NullString
	var w, h sql.NullInt64
	dest := []any{
		&r.ID, &r.PublicID, &r.Kind, &r.Title, &r.Excerpt,
		&r.Visibility, &r.ReviewState,
		&r.ReplyCount, &r.LikeCount, &r.ViewCount, &r.LastReplyAt, &r.CreatedAt, &r.UpdatedAt,
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
	// extra 里可能带一个 *float64（sort=hot 的 hot_key）；用类型断言而不是多加参数，
	// 因为只有一条查询有它，而 scanTopicRow 被五条查询共用。
	for _, e := range extra {
		if p, ok := e.(*float64); ok {
			r.HotKey = *p
		}
	}
	return nil
}

// TopicSort 是排序键白名单。**拼进 SQL 的只有这两列之一，永远不拼用户输入**（§3.2）。
type TopicSort string

const (
	SortLatest TopicSort = "latest" // last_reply_at DESC, id DESC（索引 a / b）
	SortNew    TopicSort = "new"    // created_at   DESC, id DESC（索引 c / d）
	// SortHot 是「最热」（拍板 08 · L2）：键不是时间列，见 hotScoreSQL 的整段说明。
	// 它**没有** col 可拼：hotScoreSQL 是一整段表达式，作为游标键与排序列自己拼进去。
	SortHot TopicSort = "hot"
)

func (s TopicSort) column() string {
	if s == SortNew {
		return "t.created_at"
	}
	if s == SortHot {
		return hotScoreSQL
	}
	return "t.last_reply_at"
}

// hotScoreSQL 是「最热」的排序键（拍板 08 · L2）：
//
//	score = (like_count + 3 * 顶层评论数) * time_boost
//	time_boost = 1.5 当互动（最后一次点赞 / 顶层回复）在**一周内**，否则 1.0
//
// 三条口径写死在这里，别处不许各推一套：
//   - **顶层评论**用 count(posts WHERE floor > 1 AND parent_id IS NULL)：reply_count 是
//     「含楼中楼」的口径（J4），直接拿它当乘数会把楼中楼算成 3 分。两个口径各归各的用途。
//   - **互动时间**用 topics.last_interaction_at（迁移 0025 加的冗余列），**不是 now() 参与比较以外的
//     任何东西**：点赞与顶层回复都会推它；它让「一周内」有稳定的落点（now() 一变分数就变，
//     所以游标必须由服务端编码，见 forum/cursor.go 的 hotCursor）。
//   - **增益乘在整数权重上**，所以 score 是「克」不是「千克」：1.5 = 3/2。
//
// 索引命中：ORDER BY 表达式本身用不了索引，但 `(t.last_interaction_at DESC, t.id DESC)` 的排序
// 结果与 score DESC **不完全同序**（增益档一变，老的互动会被新的反超），所以这里**不假装**它走索引：
// idx_topics_hot 的用途是「先按互动时间取一段候选」，真正的排序由 Sort 完成。
// 主题量级是万级，一页 20 条；要提吞吐再说（shortcut: 全排序，主题上百万行时改成物化 score 列）。
// hotFirstPageSQL 是第一页的哨兵：比任何真实 score 都大（epoch 秒上界 ~1e11，增益 1.5）。
// 传它而不是 NULL —— 行比较遇 NULL 会让整条谓词变 NULL、静默返回零行（§3.8 规则 2）。
const hotFirstPageSQL = "1e300"

const hotScoreSQL = `((t.like_count + 3 * (SELECT count(*) FROM posts hp
        WHERE hp.topic_id = t.id AND hp.floor > 1 AND hp.parent_id IS NULL AND hp.visibility = 'normal'))
   * CASE WHEN t.last_interaction_at >= now() - interval '7 days' THEN 1.5 ELSE 1.0 END)`

// TopicFilter 是四条游标列表共用的筛选形状。
type TopicFilter struct {
	BoardID  *int64 // nil = 全站
	Kind     string // 空 = 不限
	AuthorID *int64 // 个人主页
	Sort     TopicSort
	CursorT  time.Time
	CursorID int64
	// CursorScore 只有 sort=hot 用：热度的键不是时间（见 hotScoreSQL）。
	// 语义与 CursorT 一样是**哨兵**，所以空串 = 第一页（SQL 里空串 → '1e300'，恒真）。
	CursorScore string
	Limit       int
	ViewerID    int64
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
	} else if f.Sort == SortHot {
		// 最热（拍板 08 · L2）：游标是 (score, id)，键由服务端算好放进游标 —— 时间戳那一套在这里
		// 用不了（score 不是时间，而且它随 now() 变）。表达式**只写一遍**（col = hotScoreSQL），
		// SELECT 列表与 ORDER BY 引用同一个字符串，避免「排序按 A、游标按 B」的漂移。
		sqlText = "SELECT " + topicColumns + ", " + col + " AS hot_key" +
			" FROM topics t" + boardJoin + authorJoin + coverJoin +
			" WHERE t.visibility = 'normal' AND t.review_state = 'approved'" +
			" AND ($1::bigint IS NULL OR t.board_id = $1)" +
			" AND ($2::text IS NULL OR t.kind = $2)" +
			" AND (" + col + " < $3::numeric" +
			"      OR (" + col + " = $3::numeric AND t.id < $4::bigint))" +
			" ORDER BY " + col + " DESC, t.id DESC LIMIT $5"
		score := f.CursorScore
		if score == "" {
			score = hotFirstPageSQL
		}
		args = []any{f.BoardID, nullIfEmpty(f.Kind), score, f.CursorID, f.Limit}
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
		// 只有 sort=hot 的 SELECT 列表末尾多一列 hot_key（scanTopicRow 的 extra 接住它）。
		if f.Sort == SortHot {
			var hot float64
			if err := scanTopicRow(rows, &r, &hot); err != nil {
				return err
			}
		} else if err := scanTopicRow(rows, &r); err != nil {
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
		// 与另外四条公开流同一条审核谓词（列表 / 详情 / 搜索 / 个人主页都有）。
		// 少了它，作者把自己的待审帖收藏之后，**待审内容会从收藏页漏出去**（盲测 D2 实测）。
		" AND t.review_state = 'approved'" +
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
	// ReviewPendingHuman 是「这一轮审核已经转人工，人在判」（review_events 最新一条的
	// verdict = 'review'）。拍板 08 §第三轮 6 要的那一档横幅文案就靠它。
	ReviewPendingHuman bool
}

// TopicDetail 一条查询拿全：主题 + 作者 + 分区 + 我是否收藏 + 我的投票 + issue 未关闭数 + 1 楼正文。
//
// canSeePending 只在管理端审核详情里为 true；公开详情恒 false。
// 正文行**不判 visibility**：删楼层那条路已拒绝 floor = 1（正文不是评论），
// 「正文已被作者删除」这条渲染链已拆，残留的 deleted 只可能是迁移 0061 之前的历史数据。
func (s *Store) TopicDetail(ctx context.Context, publicID string, viewerID int64, canSeePending bool) (*TopicDetailRow, error) {
	sqlText := "SELECT " + topicColumns + " " + `,
       t.board_id, b.acl_enabled, b.min_post_level, t.review_note, t.resource_status,
       -- 作者角色三列（拍板 08 §第三轮 3）：徽标要在**详情**上显示，列表项上没有那个位置。
       -- NULLIF 空串：roles.badge_color 允许 ''，而空串与 NULL 在界面上是同一件事（回落主题色）。
       r.key, r.name, NULLIF(r.badge_color, ''),
       (SELECT count(*) FROM post_issues i
         WHERE i.topic_id = t.id AND i.status = 'keep_open'),
       COALESCE((SELECT l.value FROM likes l
         WHERE l.user_id = $2 AND l.target_type = 'topic' AND l.target_id = t.id), 0),
       EXISTS (SELECT 1 FROM bookmarks bk WHERE bk.user_id = $2 AND bk.topic_id = t.id),
       -- 是否已经转人工（拍板 08 §第三轮 6）：**取最新一条判定事件**的 verdict，
       -- 不是「存在过 verdict=review」—— 一条帖先转人工、再被人工判过之后，
       -- 「存在过」会永远为真（横幅就会在明明已经判完的帖上说「已转人工」）。
       -- 最新一条 = 当前这一轮审核的结论；verdict 的值域见 ck_review_events_verdict。
       COALESCE((SELECT ev.verdict = 'review' FROM review_events ev
                  WHERE ev.topic_id = t.id
                  ORDER BY ev.created_at DESC, ev.id DESC LIMIT 1), false),
       COALESCE(p.content_md, ''), COALESCE(p.content_html, '')
  FROM topics t` + boardJoin + authorJoin + coverJoin + `
  JOIN roles r ON r.id = a.role_id
  LEFT JOIN posts p ON p.topic_id = t.id AND p.floor = 1
 WHERE t.public_id = $1
   AND ( (t.visibility = 'normal' AND t.review_state = 'approved')
         OR t.author_id = $2
         OR $3::boolean )`
	var d *TopicDetailRow
	err := s.query(ctx, sqlText, []any{publicID, viewerID, canSeePending}, func(rows *sql.Rows) error {
		var r TopicDetailRow
		var cover, avatar, avatarSmall sql.NullString
		var roleKey, roleName, roleBadge sql.NullString
		var w, h sql.NullInt64
		dest := []any{
			&r.ID, &r.PublicID, &r.Kind, &r.Title, &r.Excerpt,
			&r.Visibility, &r.ReviewState,
			&r.ReplyCount, &r.LikeCount, &r.ViewCount, &r.LastReplyAt, &r.CreatedAt, &r.UpdatedAt,
			&r.Pinned, &r.Featured, &r.Locked,
			&r.BoardSlug, &r.BoardName,
			&r.Author.ID, &r.Author.PublicID, &r.Author.Handle, &r.Author.Nickname, &avatar, &avatarSmall, &r.Author.Status,
			&cover, &w, &h,
		}
		extra := []any{
			&r.BoardID, &r.BoardACL, &r.MinPostLevel, &r.ReviewNote, &r.ResourceStatus,
			&roleKey, &roleName, &roleBadge,
			&r.IssueOpenCount, &r.MyVote, &r.Bookmarked,
			&r.ReviewPendingHuman,
			&r.ContentMD, &r.ContentHTML,
		}
		if err := rows.Scan(append(dest, extra...)...); err != nil {
			return err
		}
		r.CoverHash = scanNullString(cover)
		// 宽高与 scanTopicRow 逐字同源：详情以前漏赋值，于是 cover_width/height 恒 0（J9 核实发现）。
		if w.Valid {
			r.CoverWidth = int(w.Int64)
		}
		if h.Valid {
			r.CoverHeight = int(h.Int64)
		}
		r.Author.AvatarHash = scanNullString(avatar)
		r.Author.AvatarSmall = scanNullString(avatarSmall)
		r.Author.RoleKey = scanNullString(roleKey)
		r.Author.RoleName = scanNullString(roleName)
		r.Author.RoleBadgeColor = scanNullString(roleBadge)
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
                    last_reply_at, last_interaction_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10, $10)
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
// ResetTopicReview 把主题送回待审：**复审由「内容变了」触发，不由时间触发**（老站的流程）。
//
// 2026-10-14 修（这条路径此前是**必然 500**）：原先写的是
// `review_state = 'pending', ai_reviewed = false, ai_review_note = NULL`，
// 而 topics 表**没有 ai_reviewed / ai_review_note 这两列**（任何迁移里都没有）——
// 于是 PATCH /topics/{id} 只要带 content_md 就报「字段 t.ai_reviewed 不存在」、整个事务回滚：
// **「编辑帖子正文」在真站上是 100% 失败的**，而只改标题没事。
// （用例见 forum/review_queue_test.go 的 TestEditBodyResetsReview。）
//
// 四列一起清，语义是「这份内容还没有任何判定」：
//   - review_source = NULL 是关键：AI 任务只在自己那侧写 'ai'，见到 manual 直接返回（d7 §1 铁律）；
//     内容变过之后应当重新判，所以清空来源而不是留成 'manual'；
//   - review_note / reviewed_by / reviewed_at 一起清：留着上一版内容的判定理由与判定人，
//     会让人以为那是对新内容的结论（这正是原来那句注释想表达的）。
func ResetTopicReview(ctx context.Context, tx Querier, topicID int64, now time.Time) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE topics
		   SET review_state = 'pending',
		       review_source = NULL,
		       review_note   = NULL,
		       reviewed_by   = NULL,
		       reviewed_at   = NULL,
		       updated_at    = $2
		 WHERE id = $1`, topicID, now)
	return err
}

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
