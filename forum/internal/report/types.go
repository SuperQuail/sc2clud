package report

import "time"

// 举报目标类型：值域 topic / post / user / issue，**与迁移里的 ck_reports_target_type 逐字一致**
//（0006_social.up.sql 的三值 → 0062_issue_archive 放宽到含 issue）。
//
// 注意：多态目标本可以是「topic / post / issue_comment / user」（issue 评论也能举报），
// 但已落地的 CHECK 仍不允许 issue_comment —— 加它要再动一次迁移。
// 在这里放一个 CHECK 不允许的值，只会让插入在 PG 层炸成 500。
// 请求体里的完整值域写在 dto.go 的 binding tag（`oneof=topic post user issue`），校验只有那一处。
const (
	TargetTopic = "topic"
	TargetPost  = "post"
	// TargetIssue 的 target_id 是 Issue 的 **public_id（uuid）**，与 topic / post 同一套寻址
	//（issue_comment 那种「内部 id 直给」不存在）。
	TargetIssue = "issue"
)

// reports.state：open → handled | dismissed，终态不可逆（d6 §2.2）。
// 状态名同时出现在 dto.go 的 binding tag 与这里的两个常量上（open 用于查询与 CAS，handled 用于必填说明的判定）。
const (
	stateOpen    = "open"
	stateHandled = "handled"
)

// 举报原因值域（spam / abuse / illegal / offtopic / other，前端 REPORT_REASON 的五个键）。
// 列上没有 CHECK，**唯一**的校验点是 dto.go 里 CreateReportInput.Reason 的 binding tag
//（report_test.go 有一条检查把那个 tag 与前端 mock 的键逐字比对）。

// 站点设置里本模块读的两个键（internal/site 的键值表；阈值可以在后台改、不发版）。
const (
	settingThreshold1 = "ai.review.report_threshold_1"
	settingThreshold2 = "ai.review.report_threshold_2"
)

// 审计 action（d6 §1.1 第 3 条）。举报的**创建**不写审计：reports 表本身就是留痕。
const actionReportHandle = "report.handle"

// 分页上限（拍板 §5.1：limit 默认 20、上限 100，多取一条判到底）。
// 批量处理的上限（100，d6 §6.3）写在 BatchHandleInput 的 binding tag 上，不在代码里再存一份。
const (
	defaultLimit = 20
	maxLimit     = 100
)

type cursor struct {
	T  time.Time `json:"t"`
	ID int64     `json:"id"`
}