package report

import (
	"context"

	ent "forum/internal/ent"
)

// BoardRef 是目标所属分区（用户级举报没有分区 → nil）。
type BoardRef struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// TargetInfo 是一个被举报目标的画像。
type TargetInfo struct {
	InternalID int64     // 内部 id（reports.target_id 存的就是它）
	PublicID   string    // 对外 id（管理队列给出可点的目标）
	AuthorID   int64     // 作者（U4：不能举报自己的内容）
	Label      string    // 主题标题 / 回复摘要 / 用户昵称（队列里给人看的那一行）
	Board      *BoardRef // 用户级举报没有分区
}

// TargetResolver 由 app 层注入：**每种 target 各自由对应的域解析**
// （topic / post / issue_comment → forum，user → user），本模块不认识那些表。
//
// 两个方向各一个方法：写入时拿对外 id 换内部 id（ResolveTarget），读队列时按内部 id 还画像（TargetInfo）。
type TargetResolver interface {
	ResolveTarget(ctx context.Context, targetType, publicID string) (TargetInfo, bool, error)
	TargetInfo(ctx context.Context, targetType string, internalID int64) (TargetInfo, error)
}

// UserBrief 是本模块需要的最小用户画像（举报人 / 处理人）。
type UserBrief struct {
	PublicID string
	Handle   string
	Nickname string
	Avatar   string
}

// UserLookup 由 app 层注入 internal/user 的实现（v2 §4.2 第 3 条：各自 deps.go 定小接口）。
type UserLookup interface {
	Basic(ctx context.Context, userID int64) (UserBrief, error)
}

// Settings 是站点设置的只读视图，实现方是 internal/site。
// 本模块只读两个举报阈值（拍板 §10.4：默认 3 / 5，管理员可改）。
type Settings interface {
	SettingInt(ctx context.Context, key string) int
}

// ReportReviewInput 是「达到阈值」这件事的形状。
type ReportReviewInput struct {
	TopicID     int64 // 被举报的主题（只有主题会被复核）
	OpenReports int   // 该目标当前的未处理举报数
	Human       bool  // true = 已到第二阈值：直接进人工，不再调 AI
}

// ReviewTrigger 是「举报达到阈值 → 复核」的落点，由 app 层注入审核域的实现。
//
// 判据与阈值在本域（reports 是本域的表），动作在审核域；它与举报行**同一个事务**
// （拍板 §5.4：写库与入队必须同事务，否则会出现「举报留下了但复核没触发」）。
// 没注入实现时（审核域尚未接线）不触发 —— 举报本身照常成立。
type ReviewTrigger interface {
	TriggerReportReview(ctx context.Context, tx *ent.Tx, in ReportReviewInput) error
}
