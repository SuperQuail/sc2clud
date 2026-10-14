// Package config 定义进程的全部配置项与校验规则。
// 配置项只在这里定义：没有 koanf tag 的字段不存在。
// 依据：完全重构/后端设计/d1-platform.md §1。
package config

import "time"

// Config 是配置的全集。
type Config struct {
	Env      string   `yaml:"env" koanf:"env"` // dev | prod
	HTTP     HTTP     `yaml:"http" koanf:"http"`
	Log      Log      `yaml:"log" koanf:"log"`
	DB       DB       `yaml:"db" koanf:"db"`
	KV       KV       `yaml:"kv" koanf:"kv"`
	Queue    Queue    `yaml:"queue" koanf:"queue"`
	Mail     Mail     `yaml:"mail" koanf:"mail"`
	Auth     Auth     `yaml:"auth" koanf:"auth"`
	Image    Image    `yaml:"image" koanf:"image"`
	Captcha  Captcha  `yaml:"captcha" koanf:"captcha"`
	Site     Site     `yaml:"site" koanf:"site"`
	Web      Web      `yaml:"web" koanf:"web"`
	Capacity Capacity `yaml:"capacity" koanf:"capacity"`
	AI       AI       `yaml:"ai" koanf:"ai"`
}

// AI 是发帖审核（2026-10-13 上线刚需）。
//
// **留空 = 不启用**：此时一个外呼都不发（enabled=false 或 key 为空都算不启用）。
// endpoint 走 OpenAI 兼容的 POST {endpoint}/chat/completions（老站指向 api.deepseek.com）。
type AI struct {
	Enabled bool   `yaml:"enabled" koanf:"enabled"`
	Key     string `yaml:"key" koanf:"key"` // 从 env 给：FORUM_AI__KEY（不进仓库）
	// Endpoint 是 **OpenAI 格式的 base_url**，照 DeepSeek 文档：https://api.deepseek.com（SDK 自己拼 /chat/completions）。
	Endpoint string `yaml:"endpoint" koanf:"endpoint"`
	Model    string `yaml:"model" koanf:"model"`
	// 两套提示词（老站的设计）：新帖审核 / 举报复核。
	PromptNewPost string        `yaml:"prompt_new_post" koanf:"prompt_new_post"`
	PromptReport  string        `yaml:"prompt_report" koanf:"prompt_report"`
	MaxTokens     int           `yaml:"max_tokens" koanf:"max_tokens"`
	Interval      time.Duration `yaml:"interval" koanf:"interval"`
	Timeout       time.Duration `yaml:"timeout" koanf:"timeout"`
}

// HTTP：监听、可信代理、跨站与请求体上限。
type HTTP struct {
	Addr              string        `yaml:"addr" koanf:"addr"`
	TrustedProxies    []string      `yaml:"trusted_proxies" koanf:"trusted_proxies"` // 非空时必须交给 SetTrustedProxies，否则 ClientIP 可伪造、限流失效
	ReadHeaderTimeout time.Duration `yaml:"read_header_timeout" koanf:"read_header_timeout"`
	ReadTimeout       time.Duration `yaml:"read_timeout" koanf:"read_timeout"`
	WriteTimeout      time.Duration `yaml:"write_timeout" koanf:"write_timeout"`
	IdleTimeout       time.Duration `yaml:"idle_timeout" koanf:"idle_timeout"`
	ShutdownTimeout   time.Duration `yaml:"shutdown_timeout" koanf:"shutdown_timeout"`
	MaxHeaderBytes    int           `yaml:"max_header_bytes" koanf:"max_header_bytes"`
	BodyLimitDefault  int64         `yaml:"body_limit_default" koanf:"body_limit_default"`
	Debug             bool          `yaml:"debug" koanf:"debug"`
	CORS              CORS          `yaml:"cors" koanf:"cors"`
}

// CORS 只在跨站部署时开启；它与 Cookie 的 SameSite 是一体两面，Validate 会一起校验。
type CORS struct {
	Enabled        bool     `yaml:"enabled" koanf:"enabled"`
	AllowedOrigins []string `yaml:"allowed_origins" koanf:"allowed_origins"`
}

// Log 只控制 slog 的输出形态。
type Log struct {
	Level  string `yaml:"level" koanf:"level"`   // debug | info | warn | error
	Format string `yaml:"format" koanf:"format"` // json | text
}

// DB：单池。连接数、生命周期与超时照数据库文档 §7 写死默认值。
type DB struct {
	DSN              string        `yaml:"dsn" koanf:"dsn"` // 只从环境变量 FORUM_DB__DSN 注入，缺失即拒绝启动
	MaxConns         int32         `yaml:"max_conns" koanf:"max_conns"`
	MinConns         int32         `yaml:"min_conns" koanf:"min_conns"`
	MaxConnLifetime  time.Duration `yaml:"max_conn_lifetime" koanf:"max_conn_lifetime"`
	MaxConnIdleTime  time.Duration `yaml:"max_conn_idle_time" koanf:"max_conn_idle_time"`
	StatementTimeout time.Duration `yaml:"statement_timeout" koanf:"statement_timeout"`
	LockTimeout      time.Duration `yaml:"lock_timeout" koanf:"lock_timeout"`
	IdleTxTimeout    time.Duration `yaml:"idle_tx_timeout" koanf:"idle_tx_timeout"`
}

// KV：缓存与限流共用的 Redis 连接参数。Driver 允许 memory，但 env=prod 时 Validate 会拒绝。
type KV struct {
	Driver       string        `yaml:"driver" koanf:"driver"` // redis | memory
	Addr         string        `yaml:"addr" koanf:"addr"`
	Password     string        `yaml:"password" koanf:"password"`
	DB           int           `yaml:"db" koanf:"db"`
	DialTimeout  time.Duration `yaml:"dial_timeout" koanf:"dial_timeout"`
	ReadTimeout  time.Duration `yaml:"read_timeout" koanf:"read_timeout"`
	WriteTimeout time.Duration `yaml:"write_timeout" koanf:"write_timeout"`
}

// Queue 是 PG 队列的档位与退避参数。
type Queue struct {
	Workers      int           `yaml:"workers" koanf:"workers"` // 0 = 按 capacity.profile 取（small 4 / standard 8）
	PollInterval time.Duration `yaml:"poll_interval" koanf:"poll_interval"`
	Lease        time.Duration `yaml:"lease" koanf:"lease"`
	MaxRetry     int           `yaml:"max_retry" koanf:"max_retry"`
	BackoffBase  time.Duration `yaml:"backoff_base" koanf:"backoff_base"`
	BackoffCap   time.Duration `yaml:"backoff_cap" koanf:"backoff_cap"`
	DoneKeep     time.Duration `yaml:"done_keep" koanf:"done_keep"`
	DeadKeep     time.Duration `yaml:"dead_keep" koanf:"dead_keep"`
}

// Mail 只有主密钥；发信账号本身在数据库里（后台配置）。
type Mail struct {
	KeyHex    string `yaml:"key" koanf:"key"`         // 32 字节 hex，只从 FORUM_MAIL__KEY 注入
	OldKeyHex string `yaml:"old_key" koanf:"old_key"` // 轮换期用，多个用逗号分隔
}

// Auth 是认证参数，D2 使用；D1 只加载与校验。
//
// 后四项（Argon2MaxConcur / Argon2WaitTimeout / TouchInterval / RenewInterval）是
// 设计 d2-auth.md §4.3 的配置项，2026-10-13 由 D2 补进结构体：它们都是**运行期参数**，
// 不配也能跑（service 有同值兜底），配上了才能不改代码地调。
type Auth struct {
	SessionTTL     time.Duration `yaml:"session_ttl" koanf:"session_ttl"`
	Argon2Time     uint32        `yaml:"argon2_time" koanf:"argon2_time"`
	Argon2MemoryKB uint32        `yaml:"argon2_memory" koanf:"argon2_memory"`
	Argon2Threads  uint8         `yaml:"argon2_threads" koanf:"argon2_threads"`
	Argon2KeyLen   uint32        `yaml:"argon2_key_len" koanf:"argon2_key_len"`
	// Argon2MaxConcur 是并发哈希信号量容量（设计 §7.4：默认 2；10×32MB 会把 2GB 机器打爆）
	Argon2MaxConcur int `yaml:"argon2_max_concur" koanf:"argon2_max_concur"`
	// Argon2WaitTimeout 是等信号量的上限，超时返回 503 auth.hash_busy（设计 §7.4）
	Argon2WaitTimeout time.Duration `yaml:"argon2_wait_timeout" koanf:"argon2_wait_timeout"`
	// TouchInterval 是同一会话两次写 last_seen_at 的最小间隔（设计 §6.5）
	TouchInterval time.Duration `yaml:"touch_interval" koanf:"touch_interval"`
	// RenewInterval 是 expires_at 真正的续期间隔（设计 §6.5：默认 24h）
	RenewInterval time.Duration `yaml:"renew_interval" koanf:"renew_interval"`
	// AutoActivate 是注册激活的唯一开关（拍板 §12.2）：
	// true  = 注册即发 6 位验证码，用户自助激活；
	// false = 不发任何邮件，等管理员在后台点「激活」。
	// 它**不是**每用户状态，所以 users 表没有 activation_pending 列（拍板 §12.5）。
	AutoActivate *bool `yaml:"auto_activate" koanf:"auto_activate"`
}

// Image 是图片存储的根目录与三个上限。
type Image struct {
	Root         string `yaml:"root" koanf:"root"`
	ServeLocally bool   `yaml:"serve_locally" koanf:"serve_locally"`
	AvatarMax    int64  `yaml:"avatar_max" koanf:"avatar_max"`
	PostMax      int64  `yaml:"post_max" koanf:"post_max"`
	PaymentMax   int64  `yaml:"payment_max" koanf:"payment_max"`
}

// Captcha：off | on_failure | always。
type Captcha struct {
	Mode string `yaml:"mode" koanf:"mode"`
}

// Site 是站点身份：域名、Cookie 名、Origin 白名单、站点时区。
type Site struct {
	BaseURL        string   `yaml:"base_url" koanf:"base_url"`
	CookieName     string   `yaml:"cookie_name" koanf:"cookie_name"`
	AllowedOrigins []string `yaml:"allowed_origins" koanf:"allowed_origins"` // 空则由 BaseURL 推导（D2 的 CSRF 中间件用）
	// Timezone 是站点时区（IANA 名字，D7）：分区列表的「今日」按它算零点。
	// 老实现把这一个数字硬编码在 forum/topics.go 的 todayStart 里 —— 换时区只能改代码。
	Timezone string `yaml:"timezone" koanf:"timezone"`
}

// Location 解析 Site.Timezone。空串按默认值（与旧行为一致）。
func (s Site) Location() (*time.Location, error) {
	if s.Timezone == "" {
		return time.LoadLocation(DefaultTimezone)
	}
	return time.LoadLocation(s.Timezone)
}

// Web 是前端产物与运行期前缀。
type Web struct {
	DistDir     string `yaml:"dist_dir" koanf:"dist_dir"`
	BasePath    string `yaml:"base_path" koanf:"base_path"`       // 运行期前缀：生产 "/"、dev "/dev/"
	ServeShell  bool   `yaml:"serve_shell" koanf:"serve_shell"`   // 本地用 Vite 提供 shell 时关掉
	ServeAssets bool   `yaml:"serve_assets" koanf:"serve_assets"` // 生产由 nginx 直出 /assets/ 时关掉
}

// AutoActivateOn 返回注册是否走「发验证码自助激活」（拍板 §12.2 默认 true）。
// nil 表示没配：按默认 true。它是全局开关，不是每用户状态。
func (a Auth) AutoActivateOn() bool {
	return a.AutoActivate == nil || *a.AutoActivate
}

// BodyLimit 返回请求体默认上限。
func (h HTTP) BodyLimit() int64 {
	if h.BodyLimitDefault > 0 {
		return h.BodyLimitDefault
	}
	return 1 << 20
}

// Capacity 决定 worker 并发等档位参数。
type Capacity struct {
	Profile string `yaml:"profile" koanf:"profile"` // auto | small | standard
}

// Profile 返回生效的档位：auto 按启动时可读到的内存上限判定。
func (c Capacity) Resolve(limitBytes uint64) string {
	switch c.Profile {
	case "small", "standard":
		return c.Profile
	}
	if limitBytes >= 3<<30 {
		return "standard"
	}
	return "small"
}

// Workers 返回队列并发：配置显式给了就用它，否则按档位。
func (q Queue) WorkersFor(profile string) int {
	if q.Workers > 0 {
		return q.Workers
	}
	if profile == "standard" {
		return 8
	}
	return 4
}
