package report

import (
	"net/http"

	"forum/internal/platform/apperr"
)

// 本模块新增的错误码（d6-reward §9）。重复举报**不是**错误：它返回 200 + 既有那条（拍板 §8.11 U5）。
var (
	// ErrAlreadyHandled：处理一条已经 handled/dismissed 的举报（含并发重放；批量结果里也用它）。
	ErrAlreadyHandled = apperr.New("report.already_handled", http.StatusConflict, "这条举报已经处理过了")
)
