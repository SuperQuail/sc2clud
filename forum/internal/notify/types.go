package notify

import "time"

// CreateInput 是「在别人的事务里写一条通知」的入参（d4 §3.1）。
//
// RefID 是**内部 id**：dedup_key 由它算出（d4 §1.1 要求 payload 的 id 与 dedup_key 同源）。
// Extra 是任务入口补的渲染字段（review 的 state/text、sanction 的 until、reward 的 amount_cents）；
// 直接写通知的业务方不需要它。
type CreateInput struct {
	UserID  int64
	ActorID int64 // 触发者；系统通知为 0 → NULL
	Kind    string
	RefType string
	RefID   int64
	TopicID int64
	Link    string
	Text    string
	Extra   map[string]any
}

type ListInput struct {
	Kind       string // wire 面的 ?kind=
	UnreadOnly bool
	Cursor     string
	Limit      int
}

// MarkReadInput：两个字段都空 → 参数错（不把空数组当「全部」，d4 §3.1）。
type MarkReadInput struct {
	PublicIDs []string
	All       bool
}

// MuteInput：Type 是通知类别，或 "link"（按内容静音，此时 RefType/RefID 才有意义）。
type MuteInput struct {
	Type    string
	RefType string
	RefID   int64
}

type ListResult struct {
	Items      []NotificationDTO
	NextCursor string // "" = 到底
}

// NotificationDTO 是列表项的响应形状（JSON 字段名即契约）。
type NotificationDTO struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	Payload   map[string]any `json:"payload"`
	Link      string         `json:"link"`
	ReadAt    *time.Time     `json:"read_at"`
	CreatedAt time.Time      `json:"created_at"`
	Actor     *UserBrief     `json:"actor"` // nil = 触发者已注销
}

// UserBrief 是渲染 actor 需要的最小资料。内部 id 不出 API（拍板 §5.6），所以不打进 JSON。
type UserBrief struct {
	ID          int64  `json:"-"`
	Handle      string `json:"handle"`
	Nickname    string `json:"nickname"`
	Avatar      string `json:"avatar"`
	AvatarSmall string `json:"avatar_small"`
}
