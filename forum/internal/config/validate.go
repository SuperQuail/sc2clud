package config

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Validate 只做信任边界上的校验：必填非空、格式与取值域。
// 不做「DSN 能不能连」这类探测——那是 NewInfra 的事（启动即失败，报在那一层）。
func (c *Config) Validate() error {
	var errs []error

	if c.Env != "dev" && c.Env != "prod" {
		errs = append(errs, fmt.Errorf("env must be dev|prod, got %q", c.Env))
	}
	if c.DB.DSN == "" {
		errs = append(errs, errors.New("db.dsn is required (FORUM_DB__DSN)"))
	}
	if err := checkHexKey("mail.key", c.Mail.KeyHex); err != nil {
		errs = append(errs, err)
	}
	if c.Mail.OldKeyHex != "" {
		for _, k := range strings.Split(c.Mail.OldKeyHex, ",") {
			if err := checkHexKey("mail.old_key", strings.TrimSpace(k)); err != nil {
				errs = append(errs, err)
				break
			}
		}
	}
	if c.Web.DistDir == "" {
		errs = append(errs, errors.New("web.dist_dir is required"))
	}
	if c.Web.ServeShell || c.Web.ServeAssets {
		if _, err := os.Stat(filepath.Join(c.Web.DistDir, "index.html")); err != nil {
			errs = append(errs, fmt.Errorf("web.dist_dir 里没有 index.html（%s）：先构建前端产物，或把 web.serve_shell 关掉", c.Web.DistDir))
		}
	}
	if !strings.HasPrefix(c.Web.BasePath, "/") || !strings.HasSuffix(c.Web.BasePath, "/") {
		errs = append(errs, fmt.Errorf("web.base_path 必须以 / 开头并以 / 结尾，got %q", c.Web.BasePath))
	}
	if c.Image.Root == "" {
		errs = append(errs, errors.New("image.root is required"))
	}
	if c.Site.BaseURL == "" {
		errs = append(errs, errors.New("site.base_url is required (域名白名单与发信回跳要用)"))
	}
	if c.Site.CookieName == "" {
		errs = append(errs, errors.New("site.cookie_name is required"))
	}
	switch c.Captcha.Mode {
	case "off", "on_failure", "always":
	default:
		errs = append(errs, fmt.Errorf("captcha.mode must be off|on_failure|always, got %q", c.Captcha.Mode))
	}
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		errs = append(errs, fmt.Errorf("log.level must be debug|info|warn|error, got %q", c.Log.Level))
	}
	if c.HTTP.CORS.Enabled && (len(c.HTTP.CORS.AllowedOrigins) == 0 || !c.usesSecureCookie()) {
		errs = append(errs, errors.New("http.cors.enabled requires非空 allowed_origins 且 site.base_url 是 https（跨站必须 SameSite=None; Secure，只改半边登录态直接失效）"))
	}
	// 内存实现仅供本地测试与 CI：production 用它等于限流与缓存在多实例下各算各的
	if c.Env == "prod" && c.KV.Driver == "memory" {
		errs = append(errs, errors.New("kv.driver=memory 不允许在 env=prod 下使用"))
	}
	if c.KV.Driver != "redis" && c.KV.Driver != "memory" {
		errs = append(errs, fmt.Errorf("kv.driver must be redis|memory, got %q", c.KV.Driver))
	}

	// 数值类配置不能是「死值」。它们为 0 或负数时的故障不是「慢」，而是「永远不动」：
	// 信号量永远取不到、每次请求都写一次热点行。这属于配置错误，必须启动时拒绝，
	// 不能留给运行期降级——降级的前提是「还能工作」，而这些值下它不能工作。
	if c.Auth.Argon2MaxConcur < 1 {
		errs = append(errs, errors.New("auth.argon2_max_concur 必须 >= 1：配成 0 时哈希信号量永远取不到，所有登录会挂住"))
	}
	if c.Auth.Argon2WaitTimeout <= 0 {
		errs = append(errs, errors.New("auth.argon2_wait_timeout 必须 > 0：配成 0 时等信号量立即超时，登录会全部返回 503"))
	}
	if c.Auth.TouchInterval <= 0 {
		errs = append(errs, errors.New("auth.touch_interval 必须 > 0：配成 0 时每个请求都写一次 last_seen_at，会话表变成写热点"))
	}
	if c.Auth.RenewInterval <= 0 {
		errs = append(errs, errors.New("auth.renew_interval 必须 > 0：配成 0 时每次 touch 都改 expires_at，续期本身变成写热点"))
	}
	// 租约配成 0 时 locked_until = now，恢复循环下一轮就把 running 收回 pending → 任务被无限重投
	// （永远做不完，还会把 attempts 打满进 dead）
	if c.Queue.Lease <= 0 {
		errs = append(errs, errors.New("queue.lease 必须 > 0：配成 0 时租约立即过期，恢复循环会把在跑的任务无限重投"))
	}
	// 这条不是「卡死」而是「panic」：time.NewTicker 的契约要求 d > 0。
	// 配置错导致进程 panic 同样不是「值好不好」的问题——非法值就该在 Validate 里被说清。
	if c.Queue.PollInterval <= 0 {
		errs = append(errs, errors.New("queue.poll_interval 必须 > 0：配成 0 时 time.NewTicker 会 panic"))
	}
	// 这两个是连接池的护栏，配成 0 = 关掉护栏：锁等待无限期挂住、忘了提交的事务永久占连接。
	// 单条连接被挂住不会立刻出事，但 16 条全被挂住就是服务永久卡住。
	if c.DB.LockTimeout <= 0 {
		errs = append(errs, errors.New("db.lock_timeout 必须 > 0：配成 0 时锁等待无限期挂住，连接被逐条耗光"))
	}
	if c.DB.IdleTxTimeout <= 0 {
		errs = append(errs, errors.New("db.idle_tx_timeout 必须 > 0：配成 0 时忘了提交的事务永久占住连接并顶住 vacuum"))
	}

	return errors.Join(errs...)
}

// usesSecureCookie 判断 base_url 是否是 https；Cookie 的 Secure 属性由它推导（D2 使用）。
func (c *Config) usesSecureCookie() bool {
	return strings.HasPrefix(c.Site.BaseURL, "https://")
}

func checkHexKey(field, v string) error {
	if v == "" {
		return fmt.Errorf("%s is required", field)
	}
	raw, err := hex.DecodeString(v)
	if err != nil {
		return fmt.Errorf("%s must be hex: %w", field, err)
	}
	if len(raw) != 32 {
		return fmt.Errorf("%s must be 32 bytes hex (64 chars), got %d bytes", field, len(raw))
	}
	return nil
}
