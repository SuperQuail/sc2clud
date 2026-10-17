package mail

import (
	"net/http"

	"forum/internal/platform/apperr"
)

// 本模块新增的错误码（d6-reward §9）。
var (
	// ErrNoAccount：一个可用发信账号都没有。只有**管理端的同步动作**会看到它
	// （业务投递走队列、返回 202，用户看不到这个码 —— 它表现为「邮件晚到」）。
	ErrNoAccount = apperr.New("mail.no_account", http.StatusServiceUnavailable, "还没有可用的发信账号")
	// ErrSecretUndecryptable：该账号的凭据解不开（主密钥不对 / 换过密钥没配旧钥）。
	// 不对外说细节，细节进日志。
	ErrSecretUndecryptable = apperr.New("mail.secret_undecryptable", http.StatusInternalServerError, "账号凭据无法解密，请检查主密钥配置")
)
