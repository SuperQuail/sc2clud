package media

import (
	"net/http"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
)

// 本域的错误码。**只在这里定义**（v2 §21.4：handler 不许自己造码）。
// 两条新增码已登记在回报的「需要回写文档」里（§21.4 总表）。
var (
	ErrTooLarge     = apperr.New("media.too_large", http.StatusRequestEntityTooLarge, "图片太大")
	ErrBadType      = apperr.New("media.bad_type", http.StatusBadRequest, "只接受 PNG / JPEG / GIF / WebP 图片")
	ErrDiskFull     = apperr.New("media.disk_full", http.StatusInsufficientStorage, "服务器空间不足，请稍后再试")
	ErrLimitReached = apperr.New("media.limit_reached", http.StatusBadRequest, "数量已达上限")
	ErrNotFound     = apperr.New("media.not_found", http.StatusNotFound, "图片不存在")
	// 未激活是**账号域**的判定，但写操作要在这里挡（拍板 §9.4）。码与 auth.ErrNotActivated 同名同义。
	ErrNotActivated = apperr.New("auth.not_activated", http.StatusForbidden, "账号未激活，请先完成邮箱验证")
)

// invalid 是参数校验失败的唯一出口（带 fields，前端按 JSON 字段名挂错误）。
func invalid(field, msg string) *apperr.Error {
	return apperr.Invalid(map[string]string{field: msg})
}

// requireActor 是写操作的登录兜底：路由层有 RequireLogin，队列/CLI 不走路由，只靠它。
func requireActor(a *authz.Actor) error {
	if a == nil || a.UserID == 0 {
		return apperr.ErrUnauthorized
	}
	if a.Status != "" && a.Status != "active" {
		return apperr.ErrUnauthorized
	}
	return nil
}

// requireActive 在 requireActor 之上加激活闸门（拍板 §9.4：未激活可读不可写）。
func requireActive(a *authz.Actor) error {
	if err := requireActor(a); err != nil {
		return err
	}
	if !a.Activated {
		return ErrNotActivated
	}
	return nil
}
