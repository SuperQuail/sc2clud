package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"forum/internal/platform/db"
	"forum/migrations"
)

// ai_config_import_test.go：老站 AI 配置值的导入（forum ai-config）的验收。
//
// 三件事，都是「跑一次就对、跑两次会露馅」的那种：
//  1. **值真的落库**：11 格逐格等于 manifest（接口读的就是这张表 —— 15-admin 的 AI 屏走 ConfigView）；
//  2. **可重复执行**：第二遍 changed=0（不白写 updated_at）；
//  3. **老站那两套提示词逐字在里面**（拿老站独有的句子核，防「manifest 抄错一格」）。
func TestAIConfigImportIsIdempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("要起真库，-short 跳过")
	}
	ctx := context.Background()
	cfg := e2eConfig(t)
	manifest := filepath.Join(repoDir(t), "完全重构", "迁移素材", "ai-config.json")

	// 干跑：不接库（这条路径本身也要过 —— 上线前先用它看一眼）。
	if err := AIConfig(ctx, cfg, manifest, true); err != nil {
		t.Fatalf("干跑失败: %v", err)
	}

	if err := db.Migrate(ctx, cfg.DB.DSN, migrations.FS()); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}
	in, err := NewInfra(ctx, cfg, discardLogger())
	if err != nil {
		t.Fatalf("NewInfra: %v", err)
	}
	defer in.Close()

	if err := AIConfig(ctx, cfg, manifest, false); err != nil {
		t.Fatalf("第一次导入失败: %v", err)
	}
	// 第一次必须真的改了东西（否则下面那条幂等断言什么也证明不了）。
	if n := aiConfigChanged(t, ctx, in, manifest); n != 0 {
		t.Fatalf("导入之后仍有 %d 格与 manifest 不一致", n)
	}
	if err := AIConfig(ctx, cfg, manifest, false); err != nil {
		t.Fatalf("第二次导入失败: %v", err)
	}
	if n := aiConfigChanged(t, ctx, in, manifest); n != 0 {
		t.Fatalf("第二遍之后有 %d 格漂了", n)
	}

	// 老站那两套提示词逐字在里面：老站独有的句子（「交人工复核」/「拿不准就给待定」）。
	var prompt, promptReport string
	if err := in.Pool.QueryRow(ctx,
		"SELECT prompt, prompt_report FROM ai_config WHERE id = 1").Scan(&prompt, &promptReport); err != nil {
		t.Fatalf("读提示词: %v", err)
	}
	if !strings.Contains(prompt, "交人工复核") || !strings.Contains(prompt, "星际争霸 II") {
		t.Errorf("prompt 不是老站那段（site_texts.ai_prompt_new_post）: %q", prompt)
	}
	if !strings.Contains(promptReport, "拿不准就给待定") {
		t.Errorf("prompt_report 不是老站那段（site_texts.ai_prompt_report）: %q", promptReport)
	}

	// 密钥：老站那份密文搬不过来（老站的主密钥不在备份里），所以**必须**是「没配」而不是半截值。
	var hasSecret bool
	if err := in.Pool.QueryRow(ctx,
		"SELECT secret_cipher IS NOT NULL FROM ai_config WHERE id = 1").Scan(&hasSecret); err != nil {
		t.Fatalf("读 has_secret: %v", err)
	}
	if hasSecret {
		t.Error("密钥不该被导入（老站密文用老站主密钥加密）—— 它只能由运维重配")
	}
}

// aiConfigChanged 数「库里的值与 manifest 不一致」的格数：期望值来自 manifest 本人，
// 不往用例里抄第二份常量（抄了就变成「测试与实现一起错」）。
func aiConfigChanged(t *testing.T, ctx context.Context, in *Infra, manifestPath string) int {
	t.Helper()
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("读 manifest: %v", err)
	}
	var m struct {
		Config struct {
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
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("解析 manifest: %v", err)
	}
	var got struct {
		Enabled         bool
		Provider        string
		BaseURL         string
		Model           string
		Thinking        bool
		StrictMode      bool
		Temperature     float64
		TimeoutMS       int
		MaxOutputTokens int
		Prompt          string
		PromptReport    string
	}
	if err := in.Pool.QueryRow(ctx, `SELECT enabled, provider, base_url, model, thinking, strict_mode,
		       prompt, prompt_report, temperature::float8, timeout_ms, max_output_tokens
		  FROM ai_config WHERE id = 1`).Scan(&got.Enabled, &got.Provider, &got.BaseURL, &got.Model,
		&got.Thinking, &got.StrictMode, &got.Prompt, &got.PromptReport,
		&got.Temperature, &got.TimeoutMS, &got.MaxOutputTokens); err != nil {
		t.Fatalf("读 ai_config: %v", err)
	}
	w := m.Config
	bad := 0
	check := func(name string, same bool) {
		if !same {
			t.Errorf("ai_config.%s 与 manifest 不一致", name)
			bad++
		}
	}
	check("enabled", got.Enabled == w.Enabled)
	check("provider", got.Provider == w.Provider)
	check("base_url", got.BaseURL == w.BaseURL)
	check("model", got.Model == w.Model)
	check("thinking", got.Thinking == w.Thinking)
	check("strict_mode", got.StrictMode == w.StrictMode)
	check("temperature", got.Temperature == w.Temperature)
	check("timeout_ms", got.TimeoutMS == w.TimeoutMS)
	check("max_output_tokens", got.MaxOutputTokens == w.MaxOutputTokens)
	check("prompt", got.Prompt == w.Prompt)
	check("prompt_report", got.PromptReport == w.PromptReport)
	return bad
}
