package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"forum/internal/config"
)

// AIConfig 把老站 AI 审核配置的**值**（完全重构/迁移素材/ai-config.json）导入 ai_config 单行表。
//
// 与 board-covers 同一条形状：**manifest 是资料，这条命令是落地动作**。为什么是命令而不是一段 SQL：
// 这些值是运维数据，老站的真源在备份库的 site_texts 里 —— 写成 SQL 等于把「老站的值」抄成第二份真源，
// 而且注释里说不清哪一格是逐字迁、哪一格是新站的取舍（那部分写在 manifest 的 traced / not_migrated 里）。
//
// 幂等靠「现状与目标比对」：11 格全部相等 → 一行都不写（不碰 updated_at），所以跑第二遍输出 changed=0。
// **密钥不在 manifest 里**（老站那份密文是用老站的主密钥加的，新站解不开）：走
// POST /admin/ai/config/secret 或 env FORUM_AI__KEY。
func AIConfig(ctx context.Context, cfg *config.Config, manifestPath string, dryRun bool) error {
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("ai-config: 读 manifest: %w", err)
	}
	var m aiConfigManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("ai-config: 解析 manifest %s: %w", manifestPath, err)
	}
	c := m.Config
	if c.BaseURL == "" || c.Model == "" {
		return fmt.Errorf("ai-config: manifest %s 的 config.base_url / config.model 不能为空", manifestPath)
	}
	if c.PromptReport == "" {
		return fmt.Errorf("ai-config: manifest %s 缺 config.prompt_report"+
			"（老站两套提示词是两格，别把 prompt 当成唯一的那个）", manifestPath)
	}
	// 值域与 0020 的 CHECK 同源：外呼参数写坏了要在这里就报，不能等某次审核静默失败。
	if c.Temperature < 0 || c.Temperature > 2 {
		return fmt.Errorf("ai-config: temperature=%v 超出 0–2（0020 的 CHECK）", c.Temperature)
	}
	if c.TimeoutMS < 1000 || c.TimeoutMS > 60000 {
		return fmt.Errorf("ai-config: timeout_ms=%d 超出 1000–60000（0020 的 CHECK）", c.TimeoutMS)
	}
	if c.MaxOutputTokens < 64 || c.MaxOutputTokens > 4096 {
		return fmt.Errorf("ai-config: max_output_tokens=%d 超出 64–4096（0020 的 CHECK）", c.MaxOutputTokens)
	}
	if c.Provider != "deepseek" && c.Provider != "openai_compatible" {
		return fmt.Errorf("ai-config: provider=%q 不在 deepseek|openai_compatible 里（0020 的 CHECK）", c.Provider)
	}

	if dryRun {
		// 干跑不接库（与 board-covers 同一条口径）：上线前先看一遍要写什么。
		fmt.Printf("ai-config: dry-run, manifest=%s\n", manifestPath)
		fmt.Printf("  provider=%s base_url=%s model=%s\n", c.Provider, c.BaseURL, c.Model)
		fmt.Printf("  enabled=%v thinking=%v strict_mode=%v temperature=%v timeout_ms=%d max_output_tokens=%d\n",
			c.Enabled, c.Thinking, c.StrictMode, c.Temperature, c.TimeoutMS, c.MaxOutputTokens)
		fmt.Printf("  prompt=%d 字 %s\n", len([]rune(c.Prompt)), c.Prompt)
		fmt.Printf("  prompt_report=%d 字 %s\n", len([]rune(c.PromptReport)), c.PromptReport)
		return nil
	}

	log, err := newLogger(cfg.Log)
	if err != nil {
		return err
	}
	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer in.Close()

	// 目标态与现状一次读齐：只发一条 UPDATE（不做「改了一半」的中间态），
	// 改动格数由逐格比对算出来 —— 那正是「跑第二遍 0 行」的判据。
	var (
		enabled, thinking, strict                      bool
		provider, baseURL, model, prompt, promptReport string
		temperature                                    float64
		timeoutMS, maxTokens                           int
	)
	err = in.Pool.QueryRow(ctx, `SELECT enabled, provider, base_url, model, thinking, strict_mode,
		       prompt, prompt_report, temperature::float8, timeout_ms, max_output_tokens
		  FROM ai_config WHERE id = 1`).Scan(&enabled, &provider, &baseURL, &model, &thinking, &strict,
		&prompt, &promptReport, &temperature, &timeoutMS, &maxTokens)
	if err != nil {
		return fmt.Errorf("ai-config: 读 ai_config（先跑 forum migrate）: %w", err)
	}
	changed := 0
	diff := func(same bool) {
		if !same {
			changed++
		}
	}
	diff(enabled == c.Enabled)
	diff(provider == c.Provider)
	diff(baseURL == c.BaseURL)
	diff(model == c.Model)
	diff(thinking == c.Thinking)
	diff(strict == c.StrictMode)
	diff(temperature == c.Temperature)
	diff(timeoutMS == c.TimeoutMS)
	diff(maxTokens == c.MaxOutputTokens)
	diff(prompt == c.Prompt)
	diff(promptReport == c.PromptReport)
	if changed == 0 {
		fmt.Println("ai-config: ok, changed=0 unchanged=11（库里的值与 manifest 逐格相同）")
		return nil
	}
	_, err = in.Pool.Exec(ctx, `UPDATE ai_config SET
		  enabled = $1, provider = $2, base_url = $3, model = $4, thinking = $5, strict_mode = $6,
		  prompt = $7, prompt_report = $8, temperature = $9, timeout_ms = $10, max_output_tokens = $11,
		  updated_at = now()
		 WHERE id = 1`,
		c.Enabled, c.Provider, c.BaseURL, c.Model, c.Thinking, c.StrictMode,
		c.Prompt, c.PromptReport, c.Temperature, c.TimeoutMS, c.MaxOutputTokens)
	if err != nil {
		return fmt.Errorf("ai-config: 写 ai_config: %w", err)
	}
	fmt.Printf("ai-config: ok, changed=%d unchanged=%d（密钥不在 manifest 里：走 POST /admin/ai/config/secret 或 env FORUM_AI__KEY）\n",
		changed, 11-changed)
	return nil
}

// aiConfigManifest 是 完全重构/迁移素材/ai-config.json 的形状。
// Config 的字段名逐字照 aireview/dto.go 的 ConfigView；traced / not_migrated 只用于出证据，导入不读它们
// （它们是给人看的：哪一格是逐字迁移、哪一格是新站的取舍）。
type aiConfigManifest struct {
	Note        string          `json:"note"`
	Config      aiConfigEntry   `json:"config"`
	Traced      []aiConfigTrace `json:"traced"`
	NotMigrated []aiConfigSkip  `json:"not_migrated"`
}

type aiConfigTrace struct {
	Field  string `json:"field"`
	Value  string `json:"value"`
	Legacy string `json:"legacy"`
	Note   string `json:"note"`
}

type aiConfigSkip struct {
	Field  string `json:"field"`
	Legacy string `json:"legacy"`
	Why    string `json:"why"`
}

type aiConfigEntry struct {
	Enabled         bool    `json:"enabled"`
	Provider        string  `json:"provider"`
	BaseURL         string  `json:"base_url"`
	Model           string  `json:"model"`
	Thinking        bool    `json:"thinking"`
	StrictMode      bool    `json:"strict_mode"`
	Temperature     float64 `json:"temperature"`
	TimeoutMS       int     `json:"timeout_ms"`
	MaxOutputTokens int     `json:"max_output_tokens"`
	Prompt          string  `json:"prompt"`
	PromptReport    string  `json:"prompt_report"`
}
