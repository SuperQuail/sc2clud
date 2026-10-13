package mail

import (
	"encoding/json"
	"time"

	pgmail "forum/internal/platform/mail"
)

// EnqueueInput 是**别的模块投递邮件的唯一形状**（d6 §5.5）。
//
// IdempotencyKey 必填：幂等键是任务重试与重复提交的支点（uq_mail_logs_idem），
// 由调用方按业务事实生成（例如 verify:<user_id>:<token_id>）。没有它就不该建行 ——
// 自动算一个（收件人 + 模板）会让「同一人第二封通知」永远建不出来。
type EnqueueInput struct {
	RecipientID    int64
	ToAddress      string
	Template       string
	Data           pgmail.Data
	IdempotencyKey string
}

// AdminAccount 是发信账号的后台视图。
//
// **凭据只写不读**：这里根本没有 secret_cipher / secret_nonce 字段 —— 不是查询时 select 掉，
// 没有字段就不会漏（d6 §6.10）。只有 secret_configured 与 secret_updated_at。
type AdminAccount struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	Provider         string     `json:"provider"`
	Priority         int        `json:"priority"`
	DailyLimit       int        `json:"daily_limit"`
	SentToday        int        `json:"sent_today"`
	ResetTZ          string     `json:"reset_tz"`
	FromAddress      string     `json:"from_address"`
	FromName         string     `json:"from_name"`
	Options          json.RawMessage `json:"options_json"`
	Enabled          bool       `json:"enabled"`
	Status           string     `json:"status"`
	SecretConfigured bool       `json:"secret_configured"`
	SecretUpdatedAt  *time.Time `json:"secret_updated_at"`
	LastOKAt         *time.Time `json:"last_ok_at"`
	LastError        string     `json:"last_error"`
	LastErrorAt      *time.Time `json:"last_error_at"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

// AccountInput 是新建发信账号的入参。Secret 是**明文凭据对象**（resend: {"api_key":…}；
// smtp: {"username":…,"password":…}），只在这一次请求里存活，入库前用主密钥加密。
type AccountInput struct {
	Name        string          `json:"name" binding:"required,max=64"`
	Provider    string          `json:"provider" binding:"required,oneof=resend smtp log"`
	Priority    *int            `json:"priority"`
	DailyLimit  *int            `json:"daily_limit"`
	ResetTZ     string          `json:"reset_tz"`
	FromAddress string          `json:"from_address" binding:"required,email,max=254"`
	FromName    string          `json:"from_name" binding:"max=64"`
	Options     json.RawMessage `json:"options_json"`
	Secret      json.RawMessage `json:"secret"`
	Enabled     *bool           `json:"enabled"`
	IP          string          `json:"-"`
}

// AccountPatch 是部分更新：nil = 不改。**没有 name 字段**（要改名就新建 + 归档旧的，d6 §6.10）。
// Secret 给了就轮换凭据（secret_updated_at 随之更新），不给就一个字节都不动。
type AccountPatch struct {
	Priority    *int            `json:"priority"`
	DailyLimit  *int            `json:"daily_limit"`
	ResetTZ     *string         `json:"reset_tz"`
	FromAddress *string         `json:"from_address"`
	FromName    *string         `json:"from_name"`
	Options     json.RawMessage `json:"options_json"`
	Secret      json.RawMessage `json:"secret"`
	Enabled     *bool           `json:"enabled"`
	IP          string          `json:"-"`
}

// DeleteResult：被历史 mail_logs 引用过就只归档（证据不因为删账号而消失）。
type DeleteResult struct {
	Archived bool `json:"archived"`
}

// SendTestInput 是测试发信的入参。
//
// 设计写的是「给当前管理员发一封」，但本模块拿不到别人的邮箱（users 不是本域的表，
// 也不该为了一个按钮新增一条跨域依赖）：收件人由前端从 /me 预填后带上来。
type SendTestInput struct {
	To string `json:"to" binding:"required,email,max=254"`
}

// SendTestResult 是 202 的回执：给的是 mail_logs.id（任务在后台跑，状态看这条）。
type SendTestResult struct {
	MailLogID int64 `json:"mail_log_id"`
}
