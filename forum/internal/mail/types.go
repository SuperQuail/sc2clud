package mail

import "time"

// 邮件模板（d6 §5.5）：值域 = mail_logs.template 的 CHECK = platform/mail 的 templates/ 文件名。
// 三处同名由 §10 第 49 条的自检钉住（mail_test.go 的 TestTemplatesMatchCheckAndFiles）。
const (
	TemplateVerifyEmail   = "verify_email"
	TemplateResetPassword = "reset_password"
	TemplateTest          = "test"
	TemplateNotice        = "notice"
)

// mail_logs.status 的三个态（与迁移里的 CHECK 逐字一致）。
const (
	statusPending = "pending"
	statusSent    = "sent"
	statusFailed  = "failed"
)

// 账号状态（对外 DTO 用，不是列）：archived_at 非空 = 已归档。
const (
	accountActive   = "active"
	accountArchived = "archived"
)

// 站点设置里本模块读的键（internal/site 的键值表；字符串在那边定义，这里是消费方的常量）。
const (
	settingEnabled  = "mail.enabled"
	settingSiteName = "site.name"
)

// 审计 action（d6 §1.1 第 7–9 条）。
const (
	actionAccountCreate  = "mail.account.create"
	actionAccountUpdate  = "mail.account.update"
	actionAccountArchive = "mail.account.archive"
)

// defaultResetTZ 是 mail_accounts.reset_tz 的列默认值：算「下一个额度重置点」时的兜底。
const defaultResetTZ = "Asia/Shanghai"

// requeueAfterReset 是「重排到明天」时的宽限（d6 §6.11：下一个自然日 00:30 + 5 分钟）。
const requeueAfterReset = 35 * time.Minute
