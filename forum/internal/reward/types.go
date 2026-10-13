package reward

import "time"

// 捐赠状态机的四个态（与迁移里的 ck_donation_records_state 逐字一致）。
const (
	StatePending   = "pending"
	StateApproved  = "approved"
	StateRejected  = "rejected"
	StateWithdrawn = "withdrawn"
)

// 站点设置里本模块读的两个键（internal/site 的键值表）。
const (
	settingEnabled = "donation.enabled"
	settingNotice  = "donation.notice_default"
)

// 分页上限与默认值（拍板 §5.1：limit 默认 20、上限 100，多取一条判到底）。
const (
	defaultLimit = 20
	maxLimit     = 100
)

type cursor struct {
	T  time.Time `json:"t"`
	ID int64     `json:"id"`
}
