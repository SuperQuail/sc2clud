package report

import "time"

// 举报目标类型。**与迁移里的 ck_reports_target_type 逐字一致**（0006_social.up.sql）。
//
// 注意：多态目标本来是「topic / post / issue_comment / user」（issue 评论也能举报），
// 但已落地的 CHECK 只允许这三个值 —— 加 issue_comment 要动迁移（见回报的「需要迁移改动」）。
// 在这里放一个 CHECK 不允许的值，只会让插入在 PG 层炸成 500。
const (
	TargetTopic = "topic"
	TargetPost  = "post"
	TargetUser  = "user"
)

// reports.state 的三个态（与 ck_reports_state 一致）：open → handled | dismissed，终态不可逆。
const (
	stateOpen      = "open"
	stateHandled   = "handled"
	stateDismissed = "dismissed"
)

// 举报原因值域（前端 REPORT_REASON 的五个键）。列上没有 CHECK，所以这是**唯一**的校验点。
var reasons = []string{"spam", "abuse", "illegal", "offtopic", "other"}

// 站点设置里本模块读的两个键（internal/site 的键值表；阈值可以在后台改、不发版）。
const (
	settingThreshold1 = "ai.review.report_threshold_1"
	settingThreshold2 = "ai.review.report_threshold_2"
)

// 审计 action（d6 §1.1 第 3 条）。举报的**创建**不写审计：reports 表本身就是留痕。
const actionReportHandle = "report.handle"

// 分页与批量上限（拍板 §5.1 / d6 §6.6）。
const (
	defaultLimit = 20
	maxLimit     = 100
	maxBatchIDs  = 100
)

type cursor struct {
	T  time.Time `json:"t"`
	ID int64     `json:"id"`
}
