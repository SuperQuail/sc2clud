package apperr

// 契约码（v2 §21.4 的真源）。
// 规则：新增一个码 = 在这里加一行 + 加一个错误变量 + 写进 §21.4 总表；三处同名。
// 这里同时维护 code → status 的登记表，Fail 与契约测试都读它。
const (
	CodeInvalidInput     = "common.invalid_input"
	CodeUnauthorized     = "common.unauthorized"
	CodeForbidden        = "common.forbidden"
	CodeNotFound         = "common.not_found"
	CodeConflict         = "common.conflict"
	CodeRateLimited      = "common.rate_limited"
	CodeInternal         = "common.internal"
	CodeEmailUnverified  = "auth.email_unverified"
	CodeMediaTooLarge    = "media.too_large"
)

// Statuses 是 code → HTTP status 的登记表。
// 契约测试断言每个码都在这里，Fail 用它交叉校验（不一致就是代码写错了）。
var Statuses = map[string]int{
	CodeInvalidInput:    400,
	CodeUnauthorized:    401,
	CodeForbidden:       403,
	CodeEmailUnverified: 403,
	CodeNotFound:        404,
	CodeConflict:        409,
	CodeMediaTooLarge:   413,
	CodeRateLimited:     429,
	CodeInternal:        500,
}
