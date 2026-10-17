package report

import "time"

// Report 是一条举报的对外形态。字段名与前端举报屏的 ReportItem 对齐。
type Report struct {
	ID          string     `json:"id"`
	TargetType  string     `json:"target_type"`
	TargetID    string     `json:"target_id"`
	TargetLabel string     `json:"target_label"`
	Board       *BoardRef  `json:"board"`
	Reason      string     `json:"reason"`
	Detail      string     `json:"detail"`
	Reporter    *UserBrief `json:"reporter"`
	State       string     `json:"state"`
	Handler     *UserBrief `json:"handler"`
	HandledAt   *time.Time `json:"handled_at"`
	HandleNote  string     `json:"handle_note"`
	CreatedAt   time.Time  `json:"created_at"`
	// OpenReports 是同一目标当前的未处理举报数：阈值压力要看得见（省得管理员去数）
	OpenReports int `json:"open_reports"`
	// Created 只在创建举报的响应里有意义：false = 复用了既有那条（幂等，拍板 §8.11 U5）
	Created bool `json:"created"`
}

type ReportPage struct {
	Items      []Report
	NextCursor string
}

type CursorInput struct {
	Limit  int    `form:"limit"`
	Cursor string `form:"cursor"`
}

type QueueInput struct {
	State      string `form:"state" binding:"omitempty,oneof=open handled dismissed"`
	TargetType string `form:"target_type" binding:"omitempty,oneof=topic post user issue"`
	CursorInput
}

type CreateReportInput struct {
	TargetType string `json:"target_type" binding:"required,oneof=topic post user issue"`
	TargetID   string `json:"target_id" binding:"required"`
	Reason     string `json:"reason" binding:"required,oneof=spam abuse illegal offtopic other"`
	Detail     string `json:"detail" binding:"max=1000"`
}

type HandleInput struct {
	State string `json:"state" binding:"required,oneof=handled dismissed"`
	Note  string `json:"note" binding:"max=500"`
	IP    string `json:"-"`
}

type BatchHandleInput struct {
	IDs   []string `json:"ids" binding:"required,min=1,max=100"`
	State string   `json:"state" binding:"required,oneof=handled dismissed"`
	Note  string   `json:"note" binding:"max=500"`
	IP    string   `json:"-"`
}

// BatchResult 是批量处理的逐条结果（一个事务 + 逐条 CAS，d6 §6.3：一条冲突不该把整批回滚）。
type BatchResult struct {
	Results []BatchItem `json:"results"`
}

type BatchItem struct {
	ID   string `json:"id"`
	OK   bool   `json:"ok"`
	Code string `json:"code,omitempty"`
}