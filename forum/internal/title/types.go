package title

import "time"

// AssignInput：UserID 是**内部 id**（handler 已把 public_id 解析掉）；TitlePublicID 是本服务解析的。
type AssignInput struct {
	UserID        int64
	TitlePublicID string
	Revoke        bool
}

// TitleInput：PublicID 只在 UpdateTitle 里有意义；Key 只在 CreateTitle 里有意义（key 不可改）。
type TitleInput struct {
	PublicID    string
	Key         string
	Name        string
	Color       string
	Description string
	Archived    bool
}

type AddExpInput struct {
	UserID int64
	Delta  int
	Reason string
	Ref    string
}

type TitleDTO struct {
	ID          string     `json:"id"`
	Key         string     `json:"key"`
	Name        string     `json:"name"`
	Color       string     `json:"color"`
	Description string     `json:"description"`
	ArchivedAt  *time.Time `json:"archived_at"`
}

type UserTitlesDTO struct {
	Items      []TitleDTO `json:"items"`
	EquippedID string     `json:"equipped_id"` // "" = 未佩戴
}

type ExpDTO struct {
	Exp   int `json:"exp"`
	Level int `json:"level"`
}

// exp_events.reason 的值域（与 ck_exp_events_reason 逐字一致）。
const (
	ReasonManual   = "manual"
	ReasonRegister = "register"
	ReasonTopic    = "topic"
	ReasonReply    = "reply"
	ReasonLike     = "like"
	ReasonReward   = "reward"
	ReasonImport   = "import"
)
