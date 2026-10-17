package reward

import "time"

// ---- 出参（API 契约）----

// Channel 是一张收款码。ID 是对外 id，Image 形如 /img/<hash>。
type Channel struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Image string `json:"image"`
	Sort  int    `json:"sort"`
}

// UserBrief 是记录里出现的对方。只给昵称/头像，不给内部 id。
type UserBrief struct {
	Handle   string `json:"handle"`
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
}

// Donation 是一条申报的对外形态。
type Donation struct {
	ID          string     `json:"id"`
	AmountCents int64      `json:"amount_cents"`
	TxnID       string     `json:"txn_id"`
	State       string     `json:"state"`
	Note        string     `json:"note"`
	PostID      string     `json:"post_id"`
	ChannelID   string     `json:"channel_id"`
	Donor       UserBrief  `json:"donor"`
	Recipient   UserBrief  `json:"recipient"`
	Verifier    *UserBrief `json:"verifier,omitempty"`
	VerifiedAt  *time.Time `json:"verified_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// DonationPage 是游标分页的一页。
type DonationPage struct {
	Items      []Donation `json:"items"`
	NextCursor string     `json:"next_cursor"`
}

// DonationSettings 是本人的三个开关 + 文案。
type DonationSettings struct {
	ShowChannels  bool   `json:"show_channels"`
	RecordsPublic bool   `json:"records_public"`
	NoticeVisible bool   `json:"notice_visible"`
	NoticeText    string `json:"notice_text"`
}

// NoticeDefault 是按渠道的默认提示文案。
type NoticeDefault struct {
	Channel string `json:"channel"`
	Text    string `json:"text"`
}

// BatchItem 是批量核验的逐条结果。
type BatchItem struct {
	ID   string `json:"id"`
	OK   bool   `json:"ok"`
	Code string `json:"code,omitempty"`
}

// BatchResult 是批量核验的结果集：一个管理员意图 = 一个事务，逐条成败。
type BatchResult struct {
	Results []BatchItem `json:"results"`
}

// RecipientIncome 是排行榜的一行。
type RecipientIncome struct {
	User       UserBrief `json:"user"`
	TotalCents int64     `json:"total_cents"`
	Count      int64     `json:"count"`
}

// DonationStats 是管理侧统计。public_* 只算双方都同意公开的，all_* 是全部 approved。
type DonationStats struct {
	PublicTotalCents int64             `json:"public_total_cents"`
	AllTotalCents    int64             `json:"all_total_cents"`
	PublicCount      int64             `json:"public_count"`
	AllCount         int64             `json:"all_count"`
	Leaderboard      []RecipientIncome `json:"leaderboard"`
}

// ---- 入参 ----

// CreateDonationInput 是 POST /rewards 的 body。
type CreateDonationInput struct {
	ToHandle    string `json:"to_handle" binding:"required,max=32"`
	AmountCents int64  `json:"amount_cents" binding:"required,min=1,max=99999999"`
	TxnID       string `json:"txn_id" binding:"max=64"`
	PostID      string `json:"post_id" binding:"omitempty,uuid"`
	ChannelID   string `json:"channel_id" binding:"omitempty,uuid"`
	Note        string `json:"note" binding:"max=200"`
	IP          string `json:"-"` // handler 从 c.ClientIP() 填，service 不碰 gin
}

// CursorInput 是「我发出的申报」的分页参数。
type CursorInput struct {
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit" binding:"omitempty,min=1,max=100"`
}

// UserDonationsInput 是别人主页上的公开记录分页参数。
type UserDonationsInput struct {
	Handle string `form:"-"`
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit" binding:"omitempty,min=1,max=100"`
}

// QueueInput 是管理侧队列的分页与过滤。
type QueueInput struct {
	State  string `form:"state" binding:"omitempty,oneof=pending approved rejected withdrawn"`
	Cursor string `form:"cursor"`
	Limit  int    `form:"limit" binding:"omitempty,min=1,max=100"`
}

// VerifyInput 是核验 body。withdrawn 会被 oneof 挡在 400。
type VerifyInput struct {
	State string `json:"state" binding:"required,oneof=approved rejected"`
	Note  string `json:"note" binding:"max=200"`
	IP    string `json:"-"`
}

// BatchVerifyInput 是一次批量核验。
type BatchVerifyInput struct {
	IDs   []string `json:"ids" binding:"required,min=1,max=100,dive,uuid"`
	State string   `json:"state" binding:"required,oneof=approved rejected"`
	Note  string   `json:"note" binding:"max=200"`
	IP    string   `json:"-"`
}

// StatsInput 是统计参数。
type StatsInput struct {
	Top int `form:"top" binding:"omitempty,min=1,max=100"` // 排行榜取前 N，默认 10
}

// UpdateDonationSettingsInput 是 PATCH /me/donation-settings 的 body：部分字段。
type UpdateDonationSettingsInput struct {
	ShowChannels  *bool   `json:"show_channels"`
	RecordsPublic *bool   `json:"records_public"`
	NoticeVisible *bool   `json:"notice_visible"`
	NoticeText    *string `json:"notice_text" binding:"omitempty,max=200"`
}

// NoticeDefaultsInput 是整表替换：传进来的就是替换后的全集。
type NoticeDefaultsInput struct {
	Items []NoticeDefaultInput `json:"items" binding:"required,max=4,dive"`
}

// NoticeDefaultInput 是整表替换里的一项。
type NoticeDefaultInput struct {
	Channel string `json:"channel" binding:"required,oneof=default wechat alipay other"`
	Text    string `json:"text" binding:"max=200"`
}
