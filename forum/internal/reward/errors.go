package reward

import (
	"net/http"

	"forum/internal/platform/apperr"
)

// 本模块新增的错误码（d6-reward §9）。common.* 一律复用 apperr 的变量。
var (
	// ErrAlreadyHandled：核验到一个已经是目标态的申报（批量结果里也用它）。
	ErrAlreadyHandled = apperr.New("reward.already_handled", http.StatusConflict, "这条申报已经处理过了")
	// ErrInvalidTransition：核验一条已撤回的申报——用户的撤回不能被管理员单方面推翻。
	ErrInvalidTransition = apperr.New("reward.invalid_transition", http.StatusConflict, "已撤回的申报不能再核验")
	// ErrDisabled：donation.enabled = off。
	ErrDisabled = apperr.New("reward.disabled", http.StatusForbidden, "站点当前未开放赞赏")
)
