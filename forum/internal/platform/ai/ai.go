// Package ai 是 AI 审核的**协议层**：只懂「把一段文本交给模型，拿回一个判定」，
// 不懂论坛、不懂数据库、不懂状态机。
//
// 参数纪律照 完全重构/后端设计/d7-ai-review.md §3：用 Tool Calls 拿结构化输出；temperature=0；
// max_tokens 由配置给；不发 frequency/presence_penalty（官方标 deprecated）；逐条判 finish_reason；
// **不截断正文**（§2.4：截断会让 AI 只看到半篇，判出来的结论就是错的）。
//
// ⚠️ **与 d7 的一条偏差（已记档）**：d7 §3.2 要 `tool_choice:"required"`，而官方写明「思考模式下不支持
// required」；关思考要发厂商扩展字段 `thinking`，只能走 extra_body，而当前依赖
// `sashabaranov/go-openai` **不支持 extra body**（查过结构体）。所以这一版发 tools 但**不强制**
// （思考模式下官方支持工具调用），模型没调工具时按 §3.5 fail-open 到人工。
// 升级路径：换官方 `openai/openai-go`（支持 ExtraFields）即可发 thinking + required。
// **不手写 HTTP 去绕** —— 那等于自己维护一个更差的 SDK（用户明确：宁可引依赖）。
package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	openai "github.com/sashabaranov/go-openai"
)

// Verdict 是三态判定（d7 §1）。
type Verdict string

const (
	Approve Verdict = "approve"
	Reject  Verdict = "reject"
	Review  Verdict = "review" // 拿不准 / 解析失败 -> 人工（fail-open 到人工，不是放行）
)

// Categories 是违规分类词表（d7 §3.2）。
var Categories = []string{"spam", "ad", "abuse", "off_topic", "illegal", "other"}

// Config 是一次调用的参数（来自 ai_config 表）。
type Config struct {
	BaseURL         string
	Model           string
	APIKey          string
	Thinking        bool
	StrictMode      bool
	MaxOutputTokens int
	Timeout         time.Duration
}

// Result 是一次调用的结果。**解析失败不是错误**（d7 §3.5）：返回 Verdict=Review，
// 由调用方按「转人工」处理并记 last_error —— 重试也是同样结果。
type Result struct {
	Verdict    Verdict
	Reason     string
	Categories []string
	Raw        string
	Model      string
	LatencyMS  int
}

// ErrTransport 是**可重试**的那一类（网络/超时/HTTP 错误）。
var ErrTransport = errors.New("ai: 调用失败（可重试）")

// Judge 让模型判一段文本：prompt 是 system，text 是 user 消息。
func Judge(ctx context.Context, cfg Config, prompt, text string) (Result, error) {
	if cfg.APIKey == "" || cfg.BaseURL == "" || cfg.Model == "" {
		return Result{}, errors.New("ai: 未配置（缺 key / base_url / model）")
	}
	if cfg.MaxOutputTokens <= 0 {
		cfg.MaxOutputTokens = 512
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 20 * time.Second
	}
	sdkCfg := openai.DefaultConfig(cfg.APIKey)
	// 照文档：base_url 就是 https://api.deepseek.com（SDK 自己拼 /chat/completions）。
	// strict 模式要求 /beta 前缀（d7 §3.3），由配置里的 base_url 自己带。
	sdkCfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	client := openai.NewClientWithConfig(sdkCfg)

	reqCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	start := time.Now()
	resp, err := client.CreateChatCompletion(reqCtx, openai.ChatCompletionRequest{
		Model:       cfg.Model,
		MaxTokens:   cfg.MaxOutputTokens,
		Temperature: 0,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: prompt},
			{Role: openai.ChatMessageRoleUser, Content: text},
		},
		Tools: []openai.Tool{{
			Type: openai.ToolTypeFunction,
			Function: &openai.FunctionDefinition{
				Name:        "submit_review",
				Description: "提交这篇帖子的审核结论",
				Parameters:  SubmitReviewSchema(cfg.StrictMode),
			},
		}},
	})
	latency := int(time.Since(start).Milliseconds())
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrTransport, err)
	}
	return parse(resp, cfg.Model, latency), nil
}

// SubmitReviewSchema 是 submit_review 的 JSON Schema（d7 §3.2 的字段逐字；strict 模式要求写准）。
func SubmitReviewSchema(strict bool) map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"verdict": map[string]any{
				"type": "string", "enum": []string{"approve", "reject", "review"},
				"description": "通过 / 违规 / 拿不准交人工",
			},
			"reason": map[string]any{
				"type": "string", "description": "给用户看的中文理由，不超过 60 字",
			},
			"categories": map[string]any{
				"type": "array", "items": map[string]any{"type": "string", "enum": Categories},
			},
		},
		"required":             []string{"verdict", "reason"},
		"additionalProperties": false,
	}
}

// parse 照 d7 §3.5 的顺序判：任何一步不对 -> Review（交人工），不猜。
func parse(resp openai.ChatCompletionResponse, model string, latency int) Result {
	out := Result{Verdict: Review, Model: model, LatencyMS: latency}
	if len(resp.Choices) == 0 {
		out.Reason = "模型没有返回任何候选"
		return out
	}
	choice := resp.Choices[0]
	if choice.FinishReason == openai.FinishReasonLength {
		out.Reason = "模型输出被截断"
		return out
	}
	if len(choice.Message.ToolCalls) == 0 {
		out.Reason = "模型没有提交审核结论"
		out.Raw = truncate(choice.Message.Content, 500)
		return out
	}
	args := choice.Message.ToolCalls[0].Function.Arguments
	out.Raw = truncate(args, 500)
	var p struct {
		Verdict    string   `json:"verdict"`
		Reason     string   `json:"reason"`
		Categories []string `json:"categories"`
	}
	if err := json.Unmarshal([]byte(args), &p); err != nil {
		out.Reason = "模型给的结论不是约定 JSON"
		return out
	}
	switch Verdict(p.Verdict) {
	case Approve, Reject, Review:
		out.Verdict = Verdict(p.Verdict)
	default:
		out.Reason = "模型给的 verdict 不在三值内"
		return out
	}
	out.Categories = p.Categories
	out.Reason = strings.TrimSpace(p.Reason)
	if out.Reason == "" {
		out.Reason = "审核未给出理由"
	}
	return out
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
