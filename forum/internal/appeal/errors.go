package appeal

import (
	"net/http"

	"forum/internal/platform/apperr"
)

// 本域的错误码（v2 §21.4 的命名法：<域>.<语义>）。
// 「重复提交」**不是**错误：C5 幂等返回既有那条（拍板 §10.10-1），C4 由 rate_limited 兜。
var (
	// ErrRateLimited 是免登录那条路的 24 小时额度：重复到第 4 次才出现（同一身份）。
	// 与 common.rate_limited 分开：这一条要能告诉用户「等多久」，而中间件那条是通用的。
	ErrRateLimited = apperr.New("appeal.rate_limited", http.StatusTooManyRequests,
		"同一个账号 24 小时内最多提交 3 条申诉，请稍后再试")

	// ErrNotFound 在「单号 + 邮箱」对不上时也用它：区分「单号不存在」与「邮箱不对」
	// 等于给出一个枚举单号的预言机（单号是 AP-<顺序数字>，本来就好猜）。
	ErrNotFound = apperr.New("appeal.not_found", http.StatusNotFound, "没有这条申诉")

	// ErrHandled 是处理一条已经判过的申诉（含并发重放）。
	ErrHandled = apperr.New("appeal.already_handled", http.StatusConflict, "这条申诉已经处理过了")

	// 图形验证码的三个码**与 auth 域同名同码**（auth.captcha_required / _wrong / _unavailable）：
	// 前端 routes/appeal.tsx 的 errorText() 已经在按 auth.captcha_wrong 给文案，契约是那个字符串。
	// 在这里再声明一次，是因为 import auth 会把整个会话域拉进本包（本域必须能在没有登录态时跑）。
	// 三处同名（auth/errors.go、本文件、前端文案），改一处必须一起改。
	ErrCaptchaRequired    = apperr.New("auth.captcha_required", http.StatusBadRequest, "请先填写验证码")
	ErrCaptchaWrong       = apperr.New("auth.captcha_wrong", http.StatusBadRequest, "图形验证码不正确")
	ErrCaptchaUnavailable = apperr.New("auth.captcha_unavailable", http.StatusServiceUnavailable, "验证码服务暂时不可用，请稍后再试")
)
