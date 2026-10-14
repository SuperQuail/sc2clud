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
	TopicCount   int64  `json:"topic_count"`
	PostCount    int64  `json:"post_count"`
	TodayCount   int64  `json:"today_count"`
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
type TopicPage struct {
	Items      []TopicCardDTO
	NextCursor string
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
	CreatedAt      time.Time    `json:"created_at"`
	LastReplyAt    time.Time    `json:"last_reply_at"`
	UpdatedAt      time.Time    `json:"updated_at"`
	ReviewState    string       `json:"review_state"`
	ReviewNote     *string      `json:"review_note"` // 只有作者看得到（拍板 §6）
	CanEdit        bool         `json:"can_edit"`
	CanReply       bool         `json:"can_reply"`
	Viewer         ViewerDTO    `json:"viewer"`
	Sources        []SourceDTO  `json:"sources"`
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
	ParentID     *string      `json:"parent_id"`
	Floor        int          `json:"floor"`
	ContentHTML  string       `json:"content_html"`
	Author       UserBriefDTO `json:"author"`
	LikeCount    int          `json:"like_count"`
	DislikeCount int          `json:"dislike_count"`
	MyVote       int          `json:"my_vote"`
	ReplyTotal   int          `json:"reply_total"`
	PreviewIDs   []string     `json:"preview_ids"`
	CreatedAt    time.Time    `json:"created_at"`
	UpdatedAt    time.Time    `json:"updated_at"`
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

// IssueCommentDTO 是 Issue 评论。
type IssueCommentDTO struct {
	ID           string       `json:"id"`
	ParentID     *string      `json:"parent_id"` // nil = 顶层（同 PostDTO，Issue 评论同病同治）
	BodyHTML     string       `json:"body_html"`
	Author       UserBriefDTO `json:"author"`
	LikeCount    int          `json:"like_count"`
	DislikeCount int          `json:"dislike_count"`
	MyVote       int          `json:"my_vote"`
	CreatedAt    time.Time    `json:"created_at"`
	UpdatedAt    time.Time    `json:"updated_at"`
}

// IssueCommentPage 是 Issue 评论的一页。
type IssueCommentPage struct {
	Items      []IssueCommentDTO
	NextCursor string
}

// VoteResultDTO 是投票后的计数（拍板 §3：两个计数 + 我的投票）。
type VoteResultDTO struct {
	LikeCount    int `json:"like_count"`
	DislikeCount int `json:"dislike_count"`
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
	Status        string // open | closed | 空
	Kind          string
	Author        string // handle
	AssigneeMe    bool
	Sort          string // updated（默认）| created | comments
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
