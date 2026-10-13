package release

import (
	"net/http"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// 本域的错误码。公开读端点的「没有」用既有 common.not_found；管理端录入用 common.invalid_input + fields。
var (
	ErrNotFound = apperr.New(apperr.CodeNotFound, http.StatusNotFound, "版本或下载源不存在")
)

func invalid(field, msg string) *apperr.Error {
	return apperr.Invalid(map[string]string{field: msg})
}

// requirePerm 是 service 层的权限兜底（队列 / CLI 不走路由，只靠它）。
// 超管短路在权限集合之前（authz 的三条硬规则第 2 条）。
func requirePerm(a *authz.Actor, perm string) error {
	if a == nil || a.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	if a.IsSuper || a.Perms.Has(perm) {
		return nil
	}
	return apperr.ErrForbidden
}
