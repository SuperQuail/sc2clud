package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	openai "github.com/sashabaranov/go-openai"

	"forum/internal/config"
	"forum/internal/forum"
)

// AI 发帖审核的编排层。
//
// **设计逐条照老站**（site/crates/sc2clud-core/src/review.rs + sc2clud-web/src/admin_ai.rs）：
//
//	· 判定三态由**三个工具**表达（tool calls，不是让模型回一段 JSON 再猜）；
//	· approve -> approved（直接放行）；pending -> 留在人工队列；reject -> rejected；
//	· 每次审核**留痕**（ai_reviews：source/verdict/reason/raw_response/model/ok）；
//	· **失败自动重试一次**，两次都不成才记 ok=false；
//	· 审核文本按 post_review_text 的形状（标题/分区/作者/正文）发过去，后台可预览。
//
// 「审过没」是 topics.ai_reviewed 一个 bool：处理过就置 true，队列因此必然前进。
// **复审由业务触发**（作者改正文 → ResetTopicReview 置回 false），不由时间触发。
const (
	// aiBatch 一轮审几条。它是**成本开关**（每条一次外呼）。
	aiBatch = 5
)

var errAINotConfigured = errors.New("ai review: 未配置（缺 key/endpoint/model 或 enabled=false）")

// aiReview 是一次审核的结果（与 ai_reviews 一行对应）。
type aiReview struct {
	Verdict forum.AiVerdict
	Reason  string
	Raw     string // 模型原话（留痕用，截断到 2000）
}

// reviewPending 扫一批待审主题交给模型判定。**没配 key 就直接返回**（一个外呼都不发）。
func reviewPending(ctx context.Context, in *Infra) error {
	if !aiConfigured(in.AI) {
		return nil
	}
	rows, err := in.DB.QueryContext(ctx, `
		SELECT t.id, t.public_id, t.title, COALESCE(b.name, ''), COALESCE(NULLIF(a.nickname, ''), a.username), COALESCE(p.content_md, '')
		  FROM topics t
		  LEFT JOIN boards b ON b.id = t.board_id
		  JOIN users a ON a.id = t.author_id
		  LEFT JOIN posts p ON p.topic_id = t.id AND p.floor = 1
		 WHERE t.review_state = 'pending' AND t.visibility = 'normal' AND NOT t.ai_reviewed
		 ORDER BY t.id
		 LIMIT $1`, aiBatch)
	if err != nil {
		return fmt.Errorf("ai review: 取待审队列: %w", err)
	}
	type item struct {
		id       int64
		publicID string
		title    string
		section  string
		author   string
		body     string
	}
	var queue []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.publicID, &it.title, &it.section, &it.author, &it.body); err != nil {
			rows.Close()
			return err
		}
		queue = append(queue, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, it := range queue {
		// shortcut: 下载来源暂不拼进审核文本（老站同样是 shortcut）；要加时把 topic_sources 取出来传给 PostReviewText。
		text := forum.PostReviewText(it.title, it.section, it.body, it.author, nil)
		review, err := aiReviewWithRetry(ctx, in, text)
		if err != nil {
			// 两次都没成：留痕 ok=false，**不置 ai_reviewed**（下一轮还会被挑中）。
			aiLog(ctx, in, it.id, "new_post", "error", err.Error(), "", false)
			in.Log.Warn("ai review: 判定失败", "topic", it.publicID, "err", err.Error())
			if isFatalAIError(err) {
				// 401/402 这类**不是可重试**错误：再试剩下几条只是把同一个错刷五遍。
				return fmt.Errorf("ai review: 配置/账户问题，本轮中止: %w", err)
			}
			continue
		}
		if err := applyAiVerdict(ctx, in, it.id, review); err != nil {
			return err
		}
		aiLog(ctx, in, it.id, "new_post", string(review.Verdict), review.Reason, review.Raw, true)
		in.Log.Info("ai review: 判定", "topic", it.publicID, "verdict", string(review.Verdict))
	}
	return nil
}

// applyAiVerdict 把判定落到帖子状态，并置 ai_reviewed。
// 三态到 review_state 的映射在论坛域里（forum.AiVerdict.ReviewState），这里只负责写。
func applyAiVerdict(ctx context.Context, in *Infra, topicID int64, r aiReview) error {
	_, err := in.DB.ExecContext(ctx, `
		UPDATE topics SET review_state = $2, ai_reviewed = true, review_note = $3
		 WHERE id = $1`, topicID, r.Verdict.ReviewState(), "AI 审核："+r.Reason)
	if err != nil {
		return fmt.Errorf("ai review: 落状态 %d: %w", topicID, err)
	}
	return nil
}

func aiLog(ctx context.Context, in *Infra, topicID int64, source, verdict, reason, raw string, ok bool) {
	if r := []rune(raw); len(r) > 2000 {
		raw = string(r[:2000])
	}
	if _, err := in.DB.ExecContext(ctx, `
		INSERT INTO ai_reviews (target_kind, target_id, source, verdict, reason, raw_response, model, ok)
		VALUES ('post', $1, $2, $3, $4, $5, $6, $7)`,
		topicID, source, verdict, reason, raw, in.AI.Model, ok); err != nil {
		// 留痕失败不该让审核结果丢失：日志里能看见。
		in.Log.Warn("ai review: 留痕失败", "topic", topicID, "err", err.Error())
	}
}

func aiConfigured(c config.AI) bool {
	return c.Enabled && c.Key != "" && c.Endpoint != "" && c.Model != ""
}

// isFatalAIError：认证失败/余额不足这类重试也没用的错误。
func isFatalAIError(err error) bool {
	var apiErr *openai.APIError
	if errors.As(err, &apiErr) {
		return apiErr.HTTPStatusCode == 401 || apiErr.HTTPStatusCode == 402
	}
	return false
}

// aiReviewWithRetry 照老站：第一次失败自动重试一次（偶发不调工具/网络抖动靠这一次救回来）。
func aiReviewWithRetry(ctx context.Context, in *Infra, text string) (aiReview, error) {
	r, err := aiReviewOnce(ctx, in, text)
	if err == nil {
		return r, nil
	}
	in.Log.Warn("ai review: 第一次失败，自动重试一次", "err", err.Error())
	return aiReviewOnce(ctx, in, text)
}

// aiReviewOnce 发一次请求。
//
// 用 **tool calls**：模型不「回一段 JSON 让我们猜」，而是**调用三个工具之一**；
// 工具名认不出来就是错误（不能默认成通过）。参数里的 reason 拿来回写批注。
func aiReviewOnce(ctx context.Context, in *Infra, text string) (aiReview, error) {
	cfg := in.AI
	if !aiConfigured(cfg) {
		return aiReview{}, errAINotConfigured
	}
	// base_url 照文档就是 https://api.deepseek.com（SDK 自己拼 /chat/completions，不要再加 /v1）。
	sdkCfg := openai.DefaultConfig(cfg.Key)
	sdkCfg.BaseURL = cfg.Endpoint
	client := openai.NewClientWithConfig(sdkCfg)

	tools := make([]openai.Tool, 0, 3)
	for _, t := range forum.AiTools("post") {
		tools = append(tools, openai.Tool{
			Type: openai.ToolTypeFunction,
			Function: &openai.FunctionDefinition{
				Name:        t.Function.Name,
				Description: t.Function.Description,
				Parameters:  t.Function.Parameters,
			},
		})
	}

	reqCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	resp, err := client.CreateChatCompletion(reqCtx, openai.ChatCompletionRequest{
		Model:     cfg.Model,
		MaxTokens: cfg.MaxTokens,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: cfg.PromptNewPost},
			{Role: openai.ChatMessageRoleUser, Content: text},
		},
		Tools: tools,
	})
	if err != nil {
		return aiReview{}, fmt.Errorf("调用失败: %w", err)
	}
	if len(resp.Choices) == 0 {
		return aiReview{}, errors.New("响应里没有 choices")
	}
	choice := resp.Choices[0]
	// 文档的警告：max_tokens 太小会把输出截断。截断的 tool call 不能当判定用。
	if choice.FinishReason == openai.FinishReasonLength {
		return aiReview{}, errors.New("输出被 max_tokens 截断（调大 max_tokens）")
	}
	if len(choice.Message.ToolCalls) == 0 {
		return aiReview{}, errors.New("模型没有调用任何工具")
	}
	call := choice.Message.ToolCalls[0]
	verdict, ok := forum.AiVerdictFromToolName(call.Function.Name, "post")
	if !ok {
		return aiReview{}, fmt.Errorf("认不出的工具名 %q", call.Function.Name)
	}
	var args struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
		return aiReview{}, fmt.Errorf("工具参数不是 JSON: %w", err)
	}
	return aiReview{Verdict: verdict, Reason: args.Reason, Raw: call.Function.Arguments}, nil
}
