package message

import (
	"net/http"

	"forum/internal/platform/apperr"
)

// CodeBlocked 是 v2 §21.4 之外新增的码（d4 §7）：任一方向拉黑时发私信。
// 不区分谁拉黑了谁——区分等于给了一个探测接口。
// 【需要 Lead 做的】把它登记进 platform/apperr 的 codes.go/vars.go 与 v2 §21.4 总表
// （本模块的写作用域不含 platform/**）。
const CodeBlocked = "message.blocked"

var errBlocked = apperr.New(CodeBlocked, http.StatusForbidden, "对方已设置不接收你的私信")
