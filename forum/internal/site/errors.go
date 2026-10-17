package site

import (
	"net/http"

	"forum/internal/platform/apperr"
)

// 本模块新增的错误码（d6-reward §9）。未知 setting key 用 common.invalid_input + fields
// （拍板 §8.11 U6：它就是参数错误，不新造码）。
var (
	// ErrBadURL：横幅的跳转链接不是 http/https 绝对地址，也不是站内相对路径。
	// 前端会把它直接放进 <a href>，所以这是信任边界上的校验（d6 §6.8）。
	ErrBadURL = apperr.New("site.bad_url", http.StatusBadRequest, "链接必须是 http/https 地址或站内路径")
)
