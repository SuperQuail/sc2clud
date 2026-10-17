package apperr

// 通用错误变量。业务模块在各自的 errors.go 里按同样的形状加自己的码。
var (
	ErrInvalidInput    = New(CodeInvalidInput, 400, "参数错误")
	ErrUnauthorized    = New(CodeUnauthorized, 401, "请先登录")
	ErrForbidden       = New(CodeForbidden, 403, "没有权限")
	ErrNotFound        = New(CodeNotFound, 404, "内容不存在")
	ErrConflict        = New(CodeConflict, 409, "数据已变化，请刷新")
	ErrRateLimited     = New(CodeRateLimited, 429, "操作太频繁")
	// 500 也要给用户一句能对日志的话：只有 code 与编号等于没给原因（D70）。
	ErrInternal        = New(CodeInternal, 500, "服务器错误，详见服务端日志")
	ErrEmailUnverified = New(CodeEmailUnverified, 403, "请先验证邮箱")
	ErrTooLarge        = New(CodeMediaTooLarge, 413, "内容过大")
)
