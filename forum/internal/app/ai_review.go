package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"forum/internal/config"
)

// AI 发帖审核（2026-10-13 上线刚需；2026-10-14 自查后修了队列堵死与「不确定=通过」两条）。
//
// 为什么挂在 cron 上而不是 CreateTopic 的钩子里：**不动领域层**，而且它顺带能审
// 「迁移进来时就是待审」的历史主题。
//
// 判定口径（安全优先）：
//
//	· ok      -> 自动 approved；
//	· 其余    -> **只写批注与模型原话，状态仍是 pending**，由人工按「不通过」。
//
// 也就是说：**只有明确说合规才放行**。模型判错一次的代价是「多发了一条待审的」，「关掉正常帖子」不会发生。
//
// shortcut: 目前只审主题。举报复核要复用这套时，把「取队列的那条 SQL + 落库动作」抽成 job，别复制一份。
const (
	// aiBatch 一轮审几条。它是**成本开关**（每条一次外呼）；要按小时/天限流时把它挪进 config 并加计数。
	aiBatch = 5
	// aiMaxBody 发给模型的正文上限（字符数）。
	aiMaxBody = 4000
	// aiNotePrefix 是「这条批注是 AI 写的」的标记 —— 人一眼能认出来，也便于以后按前缀筛。
	aiNotePrefix = "AI 审核建议不通过："
	// aiMaxRespBytes 是响应体上限：坏掉或恶意的端点不该能把我们读爆（json.Decoder 不封顶）。
	aiMaxRespBytes = 1 << 20
)

// errAINotConfigured 是「没配好」这个**可预期**的错误：调用方按「跳过本轮」处理。
var errAINotConfigured = errors.New("ai review: 未配置（缺 key/endpoint/model 或 enabled=false）")

type aiVerdict struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason"`
}

// reviewPending 扫一批待审主题交给模型判定。**没配 key 就直接返回**（一个外呼都不发）。
func reviewPending(ctx context.Context, in *Infra) error {
	if !aiConfigured(in.AI) {
		return nil
	}

	// **队列必须会前进**：只挑「没审过」或「一天前审过」的。
	// 原来只按 id 排、判违规又不改状态 —— 那 5 条会永远占住窗口，后面的帖子永远轮不到（P0）。
	rows, err := in.DB.QueryContext(ctx, `
		SELECT t.id, t.public_id, t.title, COALESCE(p.content_md, '')
		  FROM topics t
		  LEFT JOIN posts p ON p.topic_id = t.id AND p.floor = 1
		 WHERE t.review_state = 'pending' AND t.visibility = 'normal'
		   AND (t.ai_reviewed_at IS NULL OR t.ai_reviewed_at < now() - interval '1 day')
		 ORDER BY t.ai_reviewed_at NULLS FIRST, t.id
		 LIMIT $1`, aiBatch)
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

	for _, it := range queue {
		v, err := aiJudge(ctx, in, it.title, it.body)
		if err != nil {
			// 单条失败不影响这一批的其余条：外呼不可靠是常态。失败的那条**不写 ai_reviewed_at**，下一轮还会被挑中。
			in.Log.Warn("ai review: 判定失败", "topic", it.publicID, "err", err.Error())
			continue
		}
		if v.OK {
			if _, err := in.DB.ExecContext(ctx, `
				UPDATE topics SET review_state = 'approved', ai_reviewed_at = now(), ai_review_note = $2
				 WHERE id = $1`, it.id, v.Reason); err != nil {
				return fmt.Errorf("ai review: 通过 %s: %w", it.publicID, err)
			}
			in.Log.Info("ai review: 通过", "topic", it.publicID)
			continue
		}
		// 不合规（含「拿不准」）：留批注 + 模型原话，状态不动 —— 人工按「不通过」时才真的关。
		note := aiNotePrefix + v.Reason
		if r := []rune(note); len(r) > 500 {
			note = string(r[:500])
		}
		if _, err := in.DB.ExecContext(ctx, `
			UPDATE topics SET review_note = $2, ai_review_note = $3, ai_reviewed_at = now()
			 WHERE id = $1`, it.id, note, v.Reason); err != nil {
			return fmt.Errorf("ai review: 写批注 %s: %w", it.publicID, err)
		}
		in.Log.Info("ai review: 建议不通过（留待人工）", "topic", it.publicID, "reason", v.Reason)
	}
	return nil
}

func aiConfigured(c config.AI) bool {
	return c.Enabled && c.Key != "" && c.Endpoint != "" && c.Model != ""
}

// aiJudge 调一次 OpenAI 兼容的 chat/completions，只取那个 JSON。
func aiJudge(ctx context.Context, in *Infra, title, body string) (aiVerdict, error) {
	cfg := in.AI
	// 第二道守卫（第一道在 reviewPending）：**没有 key 就绝不外呼**。
	// 上线期间最容易出的事故就是没配好时猛打别人的 API —— 这条也有用例钉着。
	if !aiConfigured(cfg) {
		return aiVerdict{}, errAINotConfigured
	}
	content := "标题：" + title + "\n\n正文：\n" + body
	if r := []rune(content); len(r) > aiMaxBody {
		// 截断要**说出来**：不说的话模型会把「只看到前半段」当成「整体合规」。
		content = string(r[:aiMaxBody]) + "\n\n[正文过长，以下内容未提供]"
	}
	raw, err := json.Marshal(map[string]any{
		"model": cfg.Model,
		"messages": []map[string]string{
			{"role": "system", "content": cfg.Prompt},
			{"role": "user", "content": content},
		},
		"response_format": map[string]string{"type": "json_object"},
		"temperature":     0,
	})
	if err != nil {
		return aiVerdict{}, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost,
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
	if resp.StatusCode != http.StatusOK {
		// 错误体也读一点回来：429/401 的原因只有响应里有（对排查「为什么全部失败」是决定性的）。
		head, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return aiVerdict{}, fmt.Errorf("ai review: HTTP %d: %s", resp.StatusCode, truncateRunes(string(head), 200))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, aiMaxRespBytes)).Decode(&out); err != nil {
		return aiVerdict{}, fmt.Errorf("ai review: 响应不是 JSON: %w", err)
	}
	if len(out.Choices) == 0 {
		return aiVerdict{}, errors.New("ai review: 响应里没有 choices")
	}
	content = strings.TrimSpace(out.Choices[0].Message.Content)
	content = strings.Trim(content, "`")
	content = strings.TrimPrefix(content, "json")
	var v aiVerdict
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &v); err != nil {
		return aiVerdict{}, fmt.Errorf("ai review: 回的内容不是约定 JSON: %s", truncateRunes(content, 120))
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
