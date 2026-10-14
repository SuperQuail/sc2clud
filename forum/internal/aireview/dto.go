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
		Prompt: c.Prompt, PromptReport: c.PromptReport,
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
type TestView struct {
	Verdict    string   `json:"verdict"`
	Reason     string   `json:"reason"`
	Categories []string `json:"categories"`
	Model      string   `json:"model"`
	LatencyMS  int      `json:"latency_ms"`
	Raw        string   `json:"raw"`
}

// testText 是连通测试用的固定短文本：**不消耗任何用户内容**（d7 §8）。
const testText = "标题：连通性测试\n\n正文：这是一次连接测试，用来确认密钥与地址可用。"

func rfc3339(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}
