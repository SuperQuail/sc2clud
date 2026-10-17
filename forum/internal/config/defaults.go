package config

import "time"

// autoActivate 取布尔地址：默认值必须能与「管理员显式设成 false」区分开（nil = 用默认）。
func autoActivate(v bool) *bool { return &v }

// DefaultTimezone 是站点时区的默认值（D7）。forum 域的 DefaultSiteTZ 是同一份值：
// 业务域不 import config（见 forum/deps.go），两边只能靠评审看住 —— 而配置层永远显式传值，
// forum 的兜底只在没接线时生效，漂移的实际影响面为零。
const DefaultTimezone = "Asia/Shanghai"

// Default 返回全部默认值。加载顺序的第一段就是它（不是 yaml、不是 env）。
func Default() *Config {
	return &Config{
		Env: "dev",
		HTTP: HTTP{
			Addr:              "127.0.0.1:8081",
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
			ShutdownTimeout:   15 * time.Second,
			MaxHeaderBytes:    1 << 20,
			BodyLimitDefault:  1 << 20,
		},
		Log: Log{Level: "info", Format: "json"},
		DB: DB{
			MaxConns:         16,
			MinConns:         2,
			MaxConnLifetime:  time.Hour,
			MaxConnIdleTime:  30 * time.Minute,
			StatementTimeout: 5 * time.Second,
			LockTimeout:      2 * time.Second,
			IdleTxTimeout:    30 * time.Second,
		},
		KV: KV{
			Driver:       "memory",
			Addr:         "127.0.0.1:6379",
			DialTimeout:  2 * time.Second,
			ReadTimeout:  time.Second,
			WriteTimeout: time.Second,
		},
		Queue: Queue{
			PollInterval: time.Second,
			Lease:        5 * time.Minute,
			MaxRetry:     5,
			BackoffBase:  10 * time.Second,
			BackoffCap:   time.Hour,
			DoneKeep:     7 * 24 * time.Hour,
			DeadKeep:     30 * 24 * time.Hour,
		},
		Auth: Auth{
			SessionTTL:     720 * time.Hour,
			Argon2Time:     2,
			Argon2MemoryKB: 32768,
			Argon2Threads:  2,
			Argon2KeyLen:   32,
			// 并发哈希的上限：2 × 32MB 是 2GB 机器能承受的峰值
			Argon2MaxConcur: 2,
			// 等信号量的上限比一次哈希长得多，但比「请求超时」短
			Argon2WaitTimeout: 3 * time.Second,
			// 同一会话 10 分钟内不重复写 last_seen_at（会话表是写热点）
			TouchInterval: 10 * time.Minute,
			// expires_at 每 24h 才真的改一次，别把它变成新的写热点
			RenewInterval: 24 * time.Hour,
		},
		Image: Image{
			Root:         "data/images",
			ServeLocally: true,
			AvatarMax:    64 << 10,
			PostMax:      2 << 20,
			PaymentMax:   512 << 10,
		},
		Captcha: Captcha{Mode: "off"},
		// dev/prod 同域部署时必须用不同的名字，否则两边会话互相顶掉（部署文档 §3.2）
		Site:     Site{CookieName: "forum_session", Timezone: DefaultTimezone},
		Web:      Web{DistDir: "web/dist", BasePath: "/", ServeShell: true, ServeAssets: true},
		Capacity: Capacity{Profile: "auto"},
		// 审核默认**关着**：key 得由运维从 env 给（FORUM_AI__KEY），空 key 时一个外呼都不发。
		// 审核默认**关着**：key 由运维从 env 给（FORUM_AI__KEY），空 key 时一个外呼都不发。
		// 模型名与端点**照 DeepSeek 官方文档与老站设置**：base_url 是 https://api.deepseek.com（**不带 /v1**），
		// 现行模型名是 deepseek-flash（老站 site_texts.ai_model 也是它）。
		AI: AI{
			Endpoint: "https://api.deepseek.com",
			Model:    "deepseek-flash",
			// 提示词照老站 migrations/0029_ai_review.sql 的默认值（两套：新帖 / 举报复核）。
			// 判据不写在提示词里 —— 它写在**三个工具的描述**上（老站的设计）。
			PromptNewPost: "你是中型星际争霸 II 社区的内容审核员。判断下面这条帖子是否合规：广告与引流、来源不明的可执行文件、侵权转载、人身攻击等属于明确违规；信息不足、边界情况一律给待定，交人工复核。",
			PromptReport:  "你是社区内容审核员。下面这条内容被用户举报，请重新判定它是否违规：明确违规才给不通过，拿不准就给待定。",
			// 输出长度上限：文档要求「合理设置，防止被中途截断」。审核只要一句判词，2048 足够（含思考）。
			MaxTokens: 2048,
			Interval:  2 * time.Minute,
			Timeout:   30 * time.Second,
		},
	}
}
