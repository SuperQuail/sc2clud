package forum

import "strings"

// AI 审核的判定与「发给模型的东西」。
//
// **这一层照老站（Rust 版 core::review）的设计逐条对齐**，不是自创：
//
//	· 判定是**三态** approve / pending / reject；
//	· 三态用**三个工具**表达（tool calls，字段照 OpenAI tools 规范）——
//	  所以模型不是「返回一段 JSON 让我们猜」，而是**调用其中一个工具**；
//	· 工具名对不上任何一个是错误（不能当成「通过」）。
type AiVerdict string

const (
	AiApprove AiVerdict = "approve"
	AiPending AiVerdict = "pending"
	AiReject  AiVerdict = "reject"
)

// ReviewState 是判定落到 topics.review_state 的值。
// pending = 留在人工队列（老站原文：待定 = 不自动放行）。
func (v AiVerdict) ReviewState() string {
	switch v {
	case AiApprove:
		return "approved"
	case AiReject:
		return "rejected"
	default:
		return "pending"
	}
}

// AiVerdictFromToolName 从工具名反推判定；**认不出来就返回 false**。
func AiVerdictFromToolName(name, target string) (AiVerdict, bool) {
	switch name {
	case "approve_" + target:
		return AiApprove, true
	case "pending_" + target:
		return AiPending, true
	case "reject_" + target:
		return AiReject, true
	}
	return "", false
}

// AiTool 是 tools 数组里的一项（字段照 OpenAI Chat Completions 的 tools 规范）。
type AiTool struct {
	Type     string       `json:"type"`
	Function AiToolSchema `json:"function"`
}

type AiToolSchema struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// AiTools 给出一套（三个）工具定义。target 是 post 或 comment。
func AiTools(target string) []AiTool {
	what := "帖子"
	if target == "comment" {
		what = "评论"
	}
	reason := func(desc string) map[string]any {
		return map[string]any{
			"type": "object",
			"properties": map[string]any{
				"reason": map[string]any{"type": "string", "description": desc},
			},
			"required": []string{"reason"},
		}
	}
	tool := func(verb, desc, reasonDesc string) AiTool {
		return AiTool{
			Type: "function",
			Function: AiToolSchema{
				Name:        verb + "_" + target,
				Description: desc,
				Parameters:  reason(reasonDesc),
			},
		}
	}
	return []AiTool{
		tool("approve", what+"没有问题，内容合规，直接通过，不需要人工再看。", "一句话说明为什么通过"),
		tool("pending", "拿不准这条"+what+"是否违规，交给人工审核；信息不足、边界情况用这个。", "一句话说明哪里拿不准"),
		tool("reject", what+"有明确违规行为（广告引流、来源不明的可执行文件、侵权、人身攻击等），不通过。", "一句话说明违反了哪条"),
	}
}

// PostReviewText 是发给模型的帖子全文（后台可预览，保证所见即所发）。
// 与老站逐字同形：标题 / 分区 / 作者 / 正文，有下载来源时附在后面。
func PostReviewText(title, section, body, author string, sources []string) string {
	var b strings.Builder
	b.WriteString("【帖子】\n标题：" + title + "\n分区：" + section + "\n作者：" + author + "\n正文：\n" + body + "\n")
	if len(sources) > 0 {
		b.WriteString("下载来源：\n")
		for _, s := range sources {
			b.WriteString("- " + s + "\n")
		}
	}
	return b.String()
}

// CommentReviewText 是评论的文本化（评论没有标题与来源）。
func CommentReviewText(body, author, postTitle string) string {
	return "【评论】\n所属帖子：" + postTitle + "\n作者：" + author + "\n正文：\n" + body + "\n"
}
