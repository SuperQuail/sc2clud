package forum

import "time"

// 对外响应形状。字段名即 JSON 名（交接单 §1.2）。
// 自增 bigint 一律不出现在响应里——外面看到的 id 都是 public_id。

// UserBriefDTO 是卡片与楼层上的作者。列表查询里 JOIN users 直接取，没有 N+1。
//
// 两根头像列**在 SQL 里就回落过**（pgsql 每条作者查询：avatar_hash 空 → users.default_avatar_hash）：
// 前端拿到的是「有就用」的裸哈希，所以新加查询时必须照抄那个 COALESCE，否则作者头像会退回首字母占位。
type UserBriefDTO struct {
	Handle      string `json:"handle"`
	Nickname    string `json:"nickname"`
	AvatarHash  string `json:"avatar_hash"`
	AvatarSmall string `json:"avatar_small_hash"`
	// Role 是**基线角色**（一人一个，拍板 §1.4），只有主题详情的作者填它（拍板 08 §第三轮 3）：
	// 右栏作者卡要显示徽标，而 UserBriefDTO 是那一格的唯一数据来源。
	// 列表项与楼层上的作者留空（nil）—— 那里没有徽标位，为每一行多查一次角色是白花钱。
	Role *RoleRefDTO `json:"role"`
}

// RoleRefDTO 是徽标要的三列：key 判等、name 显示、badge_color 上色
// （roles.badge_color 可空，NULL = 徽标件自己回落主题色）。字段名照 admin 的 RoleItem。
type RoleRefDTO struct {
	Key        string  `json:"key"`
	Name       string  `json:"name"`
	BadgeColor *string `json:"badge_color"`
}

// BoardRefDTO 是卡片上的分区。
type BoardRefDTO struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// BoardDTO 是分区列表项：三个统计现算（§3.3 Q2e），没有计数列。
type BoardDTO struct {
	ID           int64  `json:"-"` // 内部用（ListPinned）；不对外
	Slug         string `json:"slug"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	CoverHash    string `json:"cover_hash"`
	ACLEnabled   bool   `json:"acl_enabled"`
	MinPostLevel int    `json:"min_post_level"`
	// MinReplyLevel 是回帖门槛（拍板 08 · E1）：老站两档门槛的第二档，与 min_post_level 同构。
	MinReplyLevel int   `json:"min_reply_level"`
	TopicCount    int64 `json:"topic_count"`
	PostCount     int64 `json:"post_count"`
	TodayCount    int64 `json:"today_count"`
}

// TopicCardDTO 是列表项（交接单 §1.2 的 TopicCardDTO）。
// cover_hash 为空表示无封面，前端按它拼 /img/<hash>。
type TopicCardDTO struct {
	ID          string       `json:"id"`
	Kind        string       `json:"kind"`
	Title       string       `json:"title"`
	Excerpt     string       `json:"excerpt"`
	Board       BoardRefDTO  `json:"board"`
	Author      UserBriefDTO `json:"author"`
	ReplyCount  int          `json:"reply_count"`
	LikeCount   int          `json:"like_count"`
	ViewCount   int64        `json:"view_count"`
	LastReplyAt time.Time    `json:"last_reply_at"`
	CreatedAt   time.Time    `json:"created_at"`
	Pinned      bool         `json:"pinned"`
	Featured    bool         `json:"featured"`
	Locked      bool         `json:"locked"`
	CoverHash   string       `json:"cover_hash"`
	CoverWidth  int          `json:"cover_width"`
	CoverHeight int          `json:"cover_height"`

	// 个人主页与收藏页才填的两项：作者看自己的帖要知道它在哪一态。
	Visibility   string     `json:"visibility,omitempty"`
	ReviewState  string     `json:"review_state,omitempty"`
	BookmarkedAt *time.Time `json:"bookmarked_at,omitempty"`
}

// TopicPage 是列表响应：{ data, next_cursor }（拍板 §5.1）。
//
// Sort 只在最热（hot）时填，且**不出现在 JSON 里**（handler 只取 Items 与 NextCursor）：
// 它是给服务端内部与测试的一个自述 —— 游标的含义取决于排序键（时间戳 vs 热度分，
// 拍板 08 · L2），报错与断言时说得出是哪种比「游标格式不正确」有用。
type TopicPage struct {
	Items      []TopicCardDTO
	NextCursor string
	Sort       string
}

// TopicBriefDTO 是置顶区块（§3.3 Q2b）：只有标题与状态，5 行以内不翻页。
type TopicBriefDTO struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Kind   string `json:"kind"`
	Locked bool   `json:"locked"`
	Pinned bool   `json:"pinned"`
}

// TopicDetailDTO 是主题详情：主题行 + 1 楼正文 + 下载源 + 我的三态（§3.7 Q6/Q7a/Q7c）。
// images[] 不在这里：topic_images 属 D5，图集由 media 的端点给。
type TopicDetailDTO struct {
	ID             string       `json:"id"`
	Kind           string       `json:"kind"`
	Title          string       `json:"title"`
	Excerpt        string       `json:"excerpt"`
	Board          BoardRefDTO  `json:"board"`
	Author         UserBriefDTO `json:"author"`
	ContentMD      string       `json:"content_md"`
	ContentHTML    string       `json:"content_html"`
	ContentDeleted bool         `json:"content_deleted"` // 1 楼被软删：标题还在、正文换成一句提示
	ResourceStatus *string      `json:"resource_status"`
	ReplyCount     int          `json:"reply_count"`
	LikeCount      int          `json:"like_count"`
	ViewCount      int64        `json:"view_count"`
	IssueOpenCount int          `json:"issue_open_count"`
	Pinned         bool         `json:"pinned"`
	Featured       bool         `json:"featured"`
	Locked         bool         `json:"locked"`
	// 封面与它的真实宽高（拍板 08 · J9 = §4.2）：与列表卡片同一个来源（topic_images 里 sort=0 的那张）。
	// 0 在这三列上只有一个含义：这张主题没有封面（前端按 cover_hash 是否为空走占位块）。
	CoverHash   string    `json:"cover_hash"`
	CoverWidth  int       `json:"cover_width"`
	CoverHeight int       `json:"cover_height"`
	CreatedAt   time.Time `json:"created_at"`
	LastReplyAt time.Time `json:"last_reply_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	ReviewState string    `json:"review_state"`
	ReviewNote  *string   `json:"review_note"` // 只有作者看得到（拍板 §6）
	// PendingDraft 说的是「你手上的 content_md 是不是还没过审的那一版」（拍板 08 第二轮 · 6.2）。
	// **读者恒 false**：他们没有待审槽，拿到的 content_md 就是线上那一版。
	// 为什么要有：作者改完正文回待审之后，界面上「这是草稿」与「这是线上那一版」在
	// content_md 里长得一模一样，而这两种情况下页面要说的话完全不同（前者「待审中」，
	// 后者「你已经改完了」）。
	PendingDraft bool `json:"pending_draft"`
	// RevisionOf 是**最后一个过审版本**，也就是读者此刻正在看的那一份（拍板 08 · L6 + 6.2）：
	// 有尚未过审的改动（PendingDraft）时才非空。作者改的是新内容（content_md 是新的），
	// 而页面要能显示「上一版过审长什么样」—— 少了它，作者只能凭 review_note 猜该改哪里。
	RevisionOf *TopicRevisionDTO `json:"revision_of"`
	CanEdit    bool              `json:"can_edit"`
	CanReply   bool              `json:"can_reply"`
	Viewer     ViewerDTO         `json:"viewer"`
	Sources    []SourceDTO       `json:"sources"`
}

// TopicRevisionDTO 是「最后过审版本」的正文（迁移 0028/0029 的 topic_revisions）。
// 两列与 TopicDetailDTO 的正文同名：前端可以把整块内容直接换掉。
type TopicRevisionDTO struct {
	ContentMD   string    `json:"content_md"`
	ContentHTML string    `json:"content_html"`
	ApprovedAt  time.Time `json:"approved_at"`
}

// ViewerDTO 是我的三态。游客恒 like=0 / bookmarked=false。
type ViewerDTO struct {
	Liked      bool `json:"liked"`
	Bookmarked bool `json:"bookmarked"`
}

// PostDTO 是楼层（交接单 §1.2）。PreviewIDs 是前 3 条楼中楼的 public_id，顺序即展示顺序。
type PostDTO struct {
	ID string `json:"id"`
	// **nil = 顶层；非空 = 父回复的 public_id**。
	// 2026-10-13 之前这里是 string（空串 = 顶层），而前端声明的是 `string | null` 并按 `=== null` 过滤 ——
	// 于是顶层楼层全被过滤掉，**评论区一条都不渲染**（接口 200 且返回数据，DOM 容器是空的）。
	// 契约两侧各写了一份约定，两边的测试都过，序列化那一层没人测。
	ParentID    *string      `json:"parent_id"`
	Floor       int          `json:"floor"`
	ContentHTML string       `json:"content_html"`
	Author      UserBriefDTO `json:"author"`
	LikeCount   int          `json:"like_count"`
	// DislikeCount 是**信任边界**（拍板 08 · J3）：普通用户拿不到这个字段（omitempty，
	// 等于「不下发」而不是「下发一个 0」）。能看的是管理员及以上与这条内容的作者。
	// 判据在 forum.ShowDislikeCount + 逐条的归属判定里，**不在前端**。
	DislikeCount int       `json:"dislike_count,omitempty"`
	MyVote       int       `json:"my_vote"`
	ReplyTotal   int       `json:"reply_total"`
	PreviewIDs   []string  `json:"preview_ids"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// PostPage 是回复列表的一页。
type PostPage struct {
	Items      []PostDTO
	NextCursor string
}

// SourceDTO 是下载源（交接单 §1.2）。GoPath 就是 302 端点的地址，前端直接当按钮的 href。
type SourceDTO struct {
	ID             string     `json:"id"`
	GoPath         string     `json:"go_path"`
	Label          string     `json:"label"`
	URL            string     `json:"url"`
	Provider       string     `json:"provider"`
	ExtractionCode *string    `json:"extraction_code"`
	Size           string     `json:"size"`
	Upkeep         string     `json:"upkeep"`
	VerifiedAt     *time.Time `json:"verified_at"`
}

// IssueDTO 是 Issue 卡片（交接单 §1.2）。
type IssueDTO struct {
	ID           string        `json:"id"`
	Number       int           `json:"number"`
	Kind         string        `json:"kind"`
	Title        string        `json:"title"`
	Status       string        `json:"status"` // open | closed（只在 service 换算，见 §7.7）
	Author       UserBriefDTO  `json:"author"`
	Assignee     *UserBriefDTO `json:"assignee"`
	Tags         []string      `json:"tags"`
	CommentCount int           `json:"comment_count"`
	CreatedAt    time.Time     `json:"created_at"`
	UpdatedAt    time.Time     `json:"updated_at"`
	ClosedAt     *time.Time    `json:"closed_at"`

	// 全站聚合与单帖列表都把所属主题带上（W3 的反馈页要显示它）。
	TopicID    string      `json:"topic_id"`
	TopicTitle string      `json:"topic_title"`
	Board      BoardRefDTO `json:"board"`
}

// IssueDetailDTO 是 Issue 详情：卡片 + 正文。
type IssueDetailDTO struct {
	IssueDTO
	BodyHTML string `json:"body_html"`
}

// IssuePage 是 Issue 列表的一页。
type IssuePage struct {
	Items      []IssueDTO
	NextCursor string
}

// IssueKindDTO 是「Issue 类型」的一个取值（GET /issues/kinds，拍板 08 · J6）。
//
// 为什么带 name 而不只是 key：值域是**数据驱动**的（issue_kinds 表），
// 而 name 是给人看的标签。前端若自己拿 key 拼中文，就等于在代码里又写了一份值域
// —— 加一类仍然要发版，正是 J6 要避免的那件事。
type IssueKindDTO struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

// IssueCommentDTO 是 Issue 评论。
type IssueCommentDTO struct {
	ID        string       `json:"id"`
	ParentID  *string      `json:"parent_id"` // nil = 顶层（同 PostDTO，Issue 评论同病同治）
	BodyHTML  string       `json:"body_html"`
	Author    UserBriefDTO `json:"author"`
	LikeCount int          `json:"like_count"`
	// DislikeCount 同 PostDTO：普通用户拿不到（拍板 08 · J3）。
	DislikeCount int       `json:"dislike_count,omitempty"`
	MyVote       int       `json:"my_vote"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// IssueCommentPage 是 Issue 评论的一页。
type IssueCommentPage struct {
	Items      []IssueCommentDTO
	NextCursor string
}

// VoteResultDTO 是投票后的计数（拍板 §3：两个计数 + 我的投票）。
//
// **契约仍是单值投票**（拍板 08 · J3 的第一句）：my_vote 只有 -1/0/1，
// 没有「既赞又踩」。DislikeCount 的可见性同 PostDTO —— 只有管理员及以上看得到。
type VoteResultDTO struct {
	LikeCount    int `json:"like_count"`
	DislikeCount int `json:"dislike_count,omitempty"`
	MyVote       int `json:"my_vote"`
}

// ---- 入参 ----

// PageInput 是只有游标与条数的列表（个人主页、收藏页、Issue 评论、楼中楼）。
type PageInput struct {
	Cursor string
	Limit  int
}

// ListTopicsInput 是首页与分区页的筛选。Board 是 slug（空 = 全站）。
type ListTopicsInput struct {
	Board  string
	Kind   string
	Sort   string // latest（默认）| new
	Cursor string
	Limit  int
}

// ListPostsInput 是回复列表。
type ListPostsInput struct {
	TopicPublicID string
	Cursor        string
	Limit         int
}

// ListIssuesInput 是 Issue 列表。TopicPublicID 为空 = 全站聚合。
type ListIssuesInput struct {
	TopicPublicID string
	Q             string // 标题 + 正文字面匹配（拍板 08 · J5 / 界面施工 §3.1）
	Status        string // open | closed | 空
	Kind          string // issue_kinds 的值域（数据驱动，拍板 08 · J6）
	Author        string // handle
	AssigneeMe    bool
	Sort          string // updated（默认）| new(=created) | old | comments
	Cursor        string
	Limit         int
}

// CreateTopicInput 是发主题。
type CreateTopicInput struct {
	BoardSlug   string
	Kind        string
	Title       string
	ContentMD   string
	ClientToken string
}

// UpdateTopicInput 是改主题：只有给了的字段才改（指针 = 没给）。
type UpdateTopicInput struct {
	Title          *string
	ContentMD      *string
	BoardSlug      *string
	Kind           *string
	ResourceStatus *string
}

// CreatePostInput 是发回复。ParentID 非空时只允许指向顶层回复。
type CreatePostInput struct {
	ContentMD   string
	ParentID    string
	ClientToken string
}

// SourceInput 是新增 / 修改下载源。
type SourceInput struct {
	Provider       string
	Label          string
	URL            string
	ExtractionCode *string
	Size           string
	Upkeep         string
}

// CreateIssueInput 是提反馈。
type CreateIssueInput struct {
	Kind        string
	Title       string
	BodyMD      string
	ClientToken string
}

// UpdateIssueInput 是改 Issue：标题 / 正文 / 开关 / 指派（指针 = 没给）。
type UpdateIssueInput struct {
	Title    *string
	BodyMD   *string
	Status   *string // open | closed
	Assignee *string // handle；空串 = 取消指派
}

// CreateCommentInput 是发 Issue 评论。
type CreateCommentInput struct {
	BodyMD   string
	ParentID string
}

// VoteTarget 是投票目标。字符串常量集而不是三个方法：三个方法会把
// 「票数加在哪个列上」这件事写三遍（交接单 §1.3）。
type VoteTarget string

const (
	VotePost         VoteTarget = "post"
	VoteIssueComment VoteTarget = "issue_comment"
	VoteTopic        VoteTarget = "topic"
)
