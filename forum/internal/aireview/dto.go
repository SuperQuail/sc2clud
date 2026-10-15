// 本文件是四个 admin 端点的线格式。字段名**逐字照 d7 §2.1 / §8 与 15-admin 的 mock**
// （web/src/devroom/pages/15-admin/mock/ai.ts 的 AiConfig）：GET/PATCH 同一套形状，密钥只有 has_secret。
package aireview

import "time"

// ConfigView 是 GET /api/v1/admin/ai/config 的回执。**永远没有密钥字段**（d7 §8 验收 12）。
type ConfigView struct {
	Enabled         bool    `json:"enabled"`
	Provider        string  `json:"provider"`
	BaseURL         string  `json:"base_url"`
	Model           string  `json:"model"`
	Thinking        bool    `json:"thinking"`
	StrictMode      bool    `json:"strict_mode"`
	TimeoutMS       int     `json:"timeout_ms"`
	MaxOutputTokens int     `json:"max_output_tokens"`
	Temperature     float64 `json:"temperature"`
	Prompt          string  `json:"prompt"`
	PromptReport    string  `json:"prompt_report"`
	// ProbeSample 是连通测试**实际会发的那段样例**（默认 = DefaultProbeSample）。
	// 界面要能看见、能改（D33②③）；改只影响那一次测试，**不落库**，所以这里给的是默认值本身。
	ProbeSample     string  `json:"probe_sample"`
	HasSecret       bool    `json:"has_secret"`
	SecretUpdatedAt *string `json:"secret_updated_at"`
	LastOKAt        *string `json:"last_ok_at"`
	LastError       string  `json:"last_error"`
	LastErrorAt     *string `json:"last_error_at"`
}

func viewOf(c *Config) *ConfigView {
	return &ConfigView{
		Enabled: c.Enabled, Provider: c.Provider, BaseURL: c.BaseURL, Model: c.Model,
		Thinking: c.Thinking, StrictMode: c.StrictMode, TimeoutMS: c.TimeoutMS,
		MaxOutputTokens: c.MaxOutputTokens, Temperature: c.Temperature,
		Prompt: c.Prompt, PromptReport: c.PromptReport, ProbeSample: DefaultProbeSample,
		HasSecret: c.HasSecret, SecretUpdatedAt: rfc3339(c.SecretUpdatedAt),
		LastOKAt:  rfc3339(c.LastOKAt),
		LastError: c.LastError, LastErrorAt: rfc3339(c.LastErrorAt),
	}
}

// ConfigPatch 是 PATCH /admin/ai/config 的请求体：**只写传进来的字段**（nil = 不动）。
// 密钥不在这里 —— 它走 POST /admin/ai/config/secret（d7 §8）。
type ConfigPatch struct {
	Enabled         *bool    `json:"enabled"`
	Provider        *string  `json:"provider"`
	BaseURL         *string  `json:"base_url"`
	Model           *string  `json:"model"`
	Thinking        *bool    `json:"thinking"`
	StrictMode      *bool    `json:"strict_mode"`
	Prompt          *string  `json:"prompt"`
	PromptReport    *string  `json:"prompt_report"`
	Temperature     *float64 `json:"temperature"`
	TimeoutMS       *int     `json:"timeout_ms"`
	MaxOutputTokens *int     `json:"max_output_tokens"`
}

// ConfigInput 是 service 的入参（只写传进来的字段，nil = 不动）。
type ConfigInput struct {
	Enabled         *bool
	Provider        *string
	BaseURL         *string
	Model           *string
	Thinking        *bool
	StrictMode      *bool
	Prompt          *string
	PromptReport    *string
	Temperature     *float64
	TimeoutMS       *int
	MaxOutputTokens *int
}

// toInput 把线格式转成 service 入参；校验在 service 里（越界值不该进库）。
func (r ConfigPatch) toInput() ConfigInput {
	return ConfigInput{
		Enabled: r.Enabled, Provider: r.Provider, BaseURL: r.BaseURL, Model: r.Model,
		Thinking: r.Thinking, StrictMode: r.StrictMode, Prompt: r.Prompt, PromptReport: r.PromptReport,
		Temperature: r.Temperature, TimeoutMS: r.TimeoutMS, MaxOutputTokens: r.MaxOutputTokens,
	}
}

// SecretInput 是 POST /admin/ai/config/secret 的请求体（只写，不回显）。
type SecretInput struct {
	APIKey string `json:"api_key"`
}

// TestView 是 POST /admin/ai/test 的回执：耗时、实际模型名、原始 verdict（d7 §8）。
// **不含密钥**，也不含请求体。
//
// 带 topic_id 试跑（D33③ 的「当场验证图片审核起效」）时后四个字段才有值：结论 + **判了几张图**。
// 连通性样例那一路没有图，images 是空数组而不是 null（前端少一个分支）。
type TestView struct {
	Verdict    string   `json:"verdict"`
	Reason     string   `json:"reason"`
	Categories []string `json:"categories"`
	Model      string   `json:"model"`
	LatencyMS  int      `json:"latency_ms"`
	Raw        string   `json:"raw"`

	TopicID      int64          `json:"topic_id"`
	ImageCount   int            `json:"image_count"`
	ImageSkipped int            `json:"image_skipped"`
	Images       []PayloadImage `json:"images"`
}

// PayloadImage 是 payload 里的一张配图 —— **发出去的那一份**的形状（D33③）。
// position / floor 回答「哪张对应帖子里的哪个位置」；数组本身的顺序 = 页面顺序。
// sent=false 时 note 一定非空（截断、超限、读不到），**不许静默丢**。
type PayloadImage struct {
	Position int    `json:"position"`
	Floor    int    `json:"floor"`
	Hash     string `json:"hash"`
	MIME     string `json:"mime"`
	Bytes    int    `json:"bytes"`
	Sent     bool   `json:"sent"`
	Note     string `json:"note"`
}

// PayloadView 是 POST /admin/ai/payload 的回执：**下一次真调用会发出去的那一份**（dry-run，不外呼）。
//
// 为什么要有这条端点：审核屏要显示 system + user 全文，而这两段**唯一**的真源是 assemblePrompt /
// userText（preview.go，真判定走的同一条路）。前端自己拼一份就是第二份真源 —— 本仓库反复栽的那个坑。
//
// 「哪里是标题、哪里是正文」不靠前端认字符串：**分段给**（user_title / user_body），
// 两段中间隔两个换行，拼起来与真发出去的 user **逐字相等**（preview_test.go 拿假外呼收到的原文比）。
// 图片（D33③ 起**真的会发**）：images[] 是逐张的下场，顺序 = 页面顺序；没发的每一张 note 都非空。
// has_image_markdown（正文里有没有 ![](…) 字面量）与 image_attachment_count（图集里挂着几张）
// 仍然都给：只给前一个，会让「正文没写字面量、图集里有图」的帖子看起来像没图。
type PayloadView struct {
	Source      string `json:"source"`   // probe（连通测试样例）| topic（一条真帖子）
	TopicID     int64  `json:"topic_id"` // probe 时为 0
	Title       string `json:"title"`
	Trigger     string `json:"trigger"`
	OpenReports int    `json:"open_reports"`

	System string `json:"system"`
	// UserPrefix 只有 trigger=report 时非空（举报复核那行「该帖已被 N 人举报」）。
	// 单列一段而不是混进 user_body：审核员要知道那行**不是作者写的**。
	UserPrefix string `json:"user_prefix"`
	UserTitle  string `json:"user_title"` // topic 专用：标题那一段（含「标题：」前缀）
	UserBody   string `json:"user_body"`  // topic 专用：正文那一段（含「正文：」前缀）
	UserText   string `json:"user_text"`  // probe 专用：连通测试发的就是样例本身，不分段

	// 图片：以前这里只有两个「事实数」（正文里有没有 ![] 字面量、图集里挂着几张），因为那时**一个字节都不上行**。
	// 现在图真的会发出去（D33③），所以这里给的是**发出去的那一份**：逐张的下场 + 四个计数。
	// has_image_markdown / image_attachment_count 保留：前者仍是「作者在正文里画了图」，后者 = len(images)。
	HasImageMarkdown     bool `json:"has_image_markdown"`
	ImageAttachmentCount int  `json:"image_attachment_count"`

	Images          []PayloadImage `json:"images"`
	ImageCount      int            `json:"image_count"`   // 真发出去的张数
	ImageSkipped    int            `json:"image_skipped"` // 被上限截掉、没发的张数
	ImageBytes      int            `json:"image_bytes"`   // 发出去的图原始字节合计（base64 后约 ×4/3）
	ImageLimit      int            `json:"image_limit"`   // 上限本身：界面要能解释「为什么只有 4 张」
	ImageMaxBytes   int            `json:"image_max_bytes"`
	ImageReadFailed bool           `json:"image_read_failed"` // true = 有图读不到 → 这次会转人工（不是违规）

	Model           string   `json:"model"`
	MaxOutputTokens int      `json:"max_output_tokens"`
	StrictMode      bool     `json:"strict_mode"`
	ToolName        string   `json:"tool_name"`
	Categories      []string `json:"categories"`
}

// payloadReq 是 POST /admin/ai/payload 的请求体；POST /admin/ai/test 复用它的 probe 字段。
type payloadReq struct {
	// TopicID 为 0 时走 probe 那一路（样例预览），否则读这条主题的标题 + 1 楼正文。
	TopicID int64 `json:"topic_id"`
	// TopicPublicID 是**管理端唯一拿得到的那个 id**：审核队列 DTO 的 id 是 topics.public_id（uuid），
	// 自增 bigint 不出现在任何管理端回执里 —— 没有它，「选一条带图帖试跑」（D33④）在界面上走不通
	//（前端只能拿 uuid 去填一个 int64 字段）。两个都给得进来：topic_id > 0 优先，否则按它查一次。
	TopicPublicID string `json:"topic_public_id"`
	// Trigger 只有 create | report（空 = create）：report 还要把未处理举报数写进第一行。
	Trigger string `json:"trigger"`
	// Probe 是**这一次**要发的样例（空 = DefaultProbeSample）。只影响这一次，不落库。
	Probe string `json:"probe"`
}

func rfc3339(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}
