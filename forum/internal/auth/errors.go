package auth

import (
	"net/http"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// 本域的错误码。**只在这里定义**（v2 §21.4 总表：handler 不许自己造码）。
// 拍板 §9.12 定案：写闸门只有 auth.not_activated；auth.email_unverified 作废，
// 所以它虽然还在 platform/apperr 里（删它要动别人），本域一处都不引用。
var (
	// 登录失败与改密码时旧密码错：**同一个码**，不区分「用户不存在」与「密码错」。
	ErrBadCredentials = apperr.New("auth.bad_credentials", http.StatusUnauthorized, "账号或密码错误")
	// 验证码 / 重置票据无效、过期、已用过、试错满 5 次——四种情况**同一个码同一句文案**（拍板 §11.4）。
	ErrTokenInvalid = apperr.New("auth.token_invalid", http.StatusBadRequest, "验证码不正确或已过期")
	// 未激活：可登录可读，写操作被它挡住（拍板 §9.4 / §9.12）。
	ErrNotActivated = apperr.New("auth.not_activated", http.StatusForbidden, "账号未激活，请先完成邮箱验证")
	// 注册时大小写撞车分开两个码：前端才能把错误挂到对应输入框上。
	ErrHandleTaken = apperr.New("auth.handle_taken", http.StatusConflict, "这个用户名已被使用")
	ErrEmailTaken  = apperr.New("auth.email_taken", http.StatusConflict, "这个邮箱已被注册")
	// 对已验证账号请求重发验证码。
	ErrEmailAlreadyVerified = apperr.New("auth.email_already_verified", http.StatusConflict, "邮箱已经验证过了")
	// argon2 信号量等超时：503 是「我这会儿处理不了」，与 429「你太快了」语义不同（方案 §9.1 写的就是 503）。
	ErrHashBusy = apperr.New("auth.hash_busy", http.StatusServiceUnavailable, "服务器繁忙，请稍后再试")
	// 一个发信账号都没有（确定性失败）。「额度满」不算——额度会恢复，那种情况只置 activation_pending='manual'（拍板 §9.5）。
	ErrMailUnavailable = apperr.New("auth.mail_unavailable", http.StatusServiceUnavailable, "邮件服务暂时不可用，请联系管理员激活账号")
	// 验证码重发 / 校验超限。带 Retry-After。
	ErrTooManyRequests = apperr.New("auth.too_many_requests", http.StatusTooManyRequests, "操作太频繁，请稍后再试")
	// 图形验证码（captcha.mode 非 off 时）。图形验证码本身由 captcha 模块实现，本域只消费它的接口。
	ErrCaptchaRequired = apperr.New("auth.captcha_required", http.StatusBadRequest, "请先填写验证码")
	ErrCaptchaWrong    = apperr.New("auth.captcha_wrong", http.StatusBadRequest, "图形验证码不正确")

	// 管理端：与公开接口的 404 分开，排障时能看出是哪一侧。
	ErrAdminUserNotFound = apperr.New("admin.user_not_found", http.StatusNotFound, "用户不存在")
	ErrAdminRoleNotFound = apperr.New("admin.role_not_found", http.StatusNotFound, "角色不存在")
	ErrAdminRoleSystem   = apperr.New("admin.role_system", http.StatusConflict, "内置角色不可删除")
	ErrAdminRoleInUse    = apperr.New("admin.role_in_use", http.StatusConflict, "还有用户在使用这个角色")
	// 必须有自己的码：前端要显示「这是最后一名超管」的专用提示（拍板 §8.9）。
	ErrAdminLastSuper   = apperr.New("admin.last_super", http.StatusConflict, "这是最后一名可用超管，不能降权或封禁")
	ErrAdminPermUnknown = apperr.New("admin.perm_unknown", http.StatusBadRequest, "权限点不存在")
)

// invalid 是参数校验失败的唯一出口（带 fields，前端按 JSON 字段名挂错误）。
func invalid(field, msg string) *apperr.Error {
	return apperr.Invalid(map[string]string{field: msg})
}

// requirePerm 是 service 层的权限兜底：队列 / cron / CLI 不走路由，只靠它。
// 顺序照 authz：未登录 / 封号 → 401；超管短路在权限集合之前（方案 §9.8）。
func requirePerm(a *authz.Actor, perm string) error {
	if a == nil || a.Status != StatusActive {
		return unauthorized()
	}
	if a.IsSuper || a.Perms.Has(perm) {
		return nil
	}
	return forbidden(perm)
}

// forbidden 是「已登录但缺权限」的唯一出口（403）。
func forbidden(perm string) *apperr.Error {
	return apperr.New(apperr.CodeForbidden, http.StatusForbidden, "没有权限："+perm)
}

// unauthorized 是「没有身份」的唯一出口（401）。
func unauthorized() *apperr.Error {
	return apperr.New(apperr.CodeUnauthorized, http.StatusUnauthorized, "请先登录")
}
