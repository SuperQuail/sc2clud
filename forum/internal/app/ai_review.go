package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// AI 发帖审核（2026-10-13 上线刚需）。
//
// 为什么挂在 cron 上而不是 CreateTopic 的钩子里：**不动领域层**（上线前要得快），
// 而且它顺带能审「迁移进来时就是待审」的历史主题。
//
// 判定口径（安全优先，宁可漏放不可误杀）：
//
//	· 模型说合规  -> 自动 approved；
//	· 模型说违规  -> **只把理由写进 review_note、状态仍是 pending**，由人来按「不通过」。
//
// 这样模型判错一次的代价是「多发了一条」，而不是「把一条正常帖子关进待审」。
// errAINotConfigured 是「没配好」这个**可预期**的错误（不是异常）：调用方按「跳过本轮」处理。
var errAINotConfigured = errors.New("ai review: 未配置（缺 key/endpoint/model 或 enabled=false）")

type aiVerdict struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason"`
}

const aiMaxBody = 4000

// reviewPending 扫一批待审主题交给模型判定。**没配 key 就直接返回**（一个外呼都不发）。
func reviewPending(ctx context.Context, in *Infra) error {
	cfg := in.AI
	if !cfg.Enabled || cfg.Key == "" || cfg.Endpoint == "" || cfg.Model == "" {
		return nil
	}

	rows, err := in.DB.QueryContext(ctx, `
		SELECT t.id, t.public_id, t.title, COALESCE(p.content_md, '')
		  FROM topics t
		  LEFT JOIN posts p ON p.topic_id = t.id AND p.floor = 1
		 WHERE t.review_state = 'pending' AND t.visibility = 'normal'
		 ORDER BY t.id
		 LIMIT 5`)
	if err != nil {
		return fmt.Errorf("ai review: 取待审队列: %w", err)
	}
	type item struct {
		id       int64
		publicID string
		title    string
		body     string
	}
	var queue []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.publicID, &it.title, &it.body); err != nil {
			rows.Close()
			return err
		}
		queue = append(queue, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(queue) == 0 {
		return nil
	}

	for _, it := range queue {
		v, err := aiJudge(ctx, in, it.title, it.body)
		if err != nil {
			// 单条失败不影响这一批的其余条：外呼不可靠是常态，别让它卡住整条审核队列。
			in.Log.Warn("ai review: 判定失败", "topic", it.publicID, "err", err.Error())
			continue
		}
		if v.OK {
			if _, err := in.DB.ExecContext(ctx, `UPDATE topics SET review_state = 'approved' WHERE id = $1`, it.id); err != nil {
				return fmt.Errorf("ai review: 通过 %s: %w", it.publicID, err)
			}
			in.Log.Info("ai review: 通过", "topic", it.publicID)
			continue
		}
		// 违规：只留批注，状态不动 —— 人工按「不通过」时才真的关。
		note := "AI 审核建议不通过：" + v.Reason
		if len([]rune(note)) > 500 {
			note = string([]rune(note)[:500])
		}
		if _, err := in.DB.ExecContext(ctx, `UPDATE topics SET review_note = $2 WHERE id = $1`, it.id, note); err != nil {
			return fmt.Errorf("ai review: 写批注 %s: %w", it.publicID, err)
		}
		in.Log.Info("ai review: 建议不通过（留待人工）", "topic", it.publicID, "reason", v.Reason)
	}
	return nil
}

// aiJudge 调一次 OpenAI 兼容的 chat/completions，只取那个 JSON。
func aiJudge(ctx context.Context, in *Infra, title, body string) (aiVerdict, error) {
	cfg := in.AI
	// 第二道守卫（第一道在 reviewPending）：**没有 key 就绝不外呼**。
	// 上线期间最容易出的事故就是在没配好时猛打别人的 API —— 这里也让它会红。
	if !cfg.Enabled || cfg.Key == "" || cfg.Endpoint == "" || cfg.Model == "" {
		return aiVerdict{}, errAINotConfigured
	}
	reqBody := map[string]any{
		"model": cfg.Model,
		"messages": []map[string]string{
			{"role": "system", "content": cfg.Prompt},
			{"role": "user", "content": "标题：" + title + "\n\n正文：\n" + truncateRunes(body, aiMaxBody)},
		},
		"response_format": map[string]string{"type": "json_object"},
		"temperature":     0,
	}
	raw, err := json.Marshal(reqBody)
	if err != nil {
		return aiVerdict{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(cfg.Endpoint, "/")+"/v1/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return aiVerdict{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return aiVerdict{}, err
	}
	defer resp.Body.Close()
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return aiVerdict{}, fmt.Errorf("AI 响应不是 JSON: %w（HTTP %d）", err, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK || len(out.Choices) == 0 {
		return aiVerdict{}, fmt.Errorf("AI 返回 HTTP %d（无 choices）", resp.StatusCode)
	}
	content := strings.TrimSpace(out.Choices[0].Message.Content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	var v aiVerdict
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &v); err != nil {
		return aiVerdict{}, fmt.Errorf("AI 回的内容不是约定 JSON: %s", truncateRunes(content, 120))
	}
	return v, nil
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
