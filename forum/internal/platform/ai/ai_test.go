package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func toolCall(v, reason string) string {
	args, _ := json.Marshal(map[string]any{"verdict": v, "reason": reason})
	b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{
		"finish_reason": "tool_calls",
		"message": map[string]any{
			"role": "assistant",
			"tool_calls": []any{map[string]any{
				"id": "c1", "type": "function",
				"function": map[string]any{"name": "submit_review", "arguments": string(args)},
			}},
		},
	}}})
	return string(b)
}

func serve(t *testing.T, resp string, status int, check func(*http.Request, string)) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		raw, _ := json.Marshal(body)
		if check != nil {
			check(r, string(raw))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(resp))
	}))
}

// 三态都能解析出来，且请求里带的是 tools（不是让模型回自由文本）。
func TestJudgeParsesThreeVerdicts(t *testing.T) {
	for _, want := range []Verdict{Approve, Reject, Review} {
		var seen string
		srv := serve(t, toolCall(string(want), "理由"), 200, func(r *http.Request, body string) {
			seen = body
			if r.URL.Path != "/chat/completions" {
				t.Errorf("base_url 不该带 /v1：实际 %q", r.URL.Path)
			}
		})
		got, err := Judge(context.Background(), Config{BaseURL: srv.URL, Model: "deepseek-flash", APIKey: "k", Timeout: time.Second}, "p", "t")
		srv.Close()
		if err != nil {
			t.Fatal(err)
		}
		if got.Verdict != want {
			t.Fatalf("verdict 解析错: 期望 %s 实际 %s", want, got.Verdict)
		}
		// 这三条是 d7 §3.2 的参数纪律，**换官方 SDK 之后必须真的发出去**（这就是换依赖要修的东西）：
		// temperature 必须是 **0**（旧依赖 float32+omitempty 会把它丢掉，判定就会抖）；
		// tool_choice 必须是**具名强制**（比 required 更确定）；非思考模式必须发 thinking: disabled。
		// ⚠️ tool_choice **不在这里断言**：上游 SDK v1.12.0 的 ToolChoice 联合字段序列化不出来
		// （赋值成功但不进请求体，SetExtraFields 又会过滤已知字段）→ 已记进 d7 §8，留了「上游修好就加回」。
		for _, key := range []string{"tools", "submit_review", "max_tokens", "\"temperature\":0", "thinking", "disabled"} {
			if !contains(seen, key) {
				t.Fatalf("请求体缺 %s：%s", key, seen)
			}
		}
	}
}

// 解析失败一律 **fail-open 到人工（review）**，绝不猜成通过。
func TestJudgeFailsOpenToHuman(t *testing.T) {
	cases := map[string]string{
		"没有 choices":    `{"choices":[]}`,
		"没有 tool_calls": `{"choices":[{"finish_reason":"stop","message":{"content":"我觉得还行"}}]}`,
		"参数不是 JSON":     `{"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":[{"function":{"name":"submit_review","arguments":"not json"}}]}}]}`,
		"verdict 不在三值":  `{"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":[{"function":{"name":"submit_review","arguments":"{\"verdict\":\"maybe\",\"reason\":\"x\"}"}}]}}]}`,
		"被截断":           `{"choices":[{"finish_reason":"length","message":{}}]}`,
	}
	for name, resp := range cases {
		srv := serve(t, resp, 200, nil)
		got, err := Judge(context.Background(), Config{BaseURL: srv.URL, Model: "m", APIKey: "k", Timeout: time.Second}, "p", "t")
		srv.Close()
		if err != nil {
			t.Fatalf("%s: 形状问题不该当传输错误: %v", name, err)
		}
		if got.Verdict != Review {
			t.Fatalf("%s: 必须 fail-open 到 review，实际 %s", name, got.Verdict)
		}
		if got.Reason == "" {
			t.Fatalf("%s: 必须给出可读的理由（运维要靠它定位）", name)
		}
	}
}

// 模型**省略 categories** 时必须是空切片而不是 nil（2026-10-14 实测）：
// 审核域把 res.Categories 直接当 TEXT[] 参数写 review_events，而那一列是
// NOT NULL DEFAULT '{}' —— nil 走 pgx 会当 SQL NULL 发出去，撞 23502，
// 结果是「模型按 schema 合法地省略了一个**非必填**字段 → 判定落不了库、任务反复重试」。
func TestJudgeAlwaysReturnsNonNilCategories(t *testing.T) {
	srv := serve(t, toolCall("approve", "正常帖子"), 200, nil)
	defer srv.Close()
	got, err := Judge(context.Background(), Config{BaseURL: srv.URL, Model: "m", APIKey: "k", Timeout: time.Second}, "p", "t")
	if err != nil {
		t.Fatal(err)
	}
	if got.Categories == nil {
		t.Fatal("Categories 是 nil：写库时会变成 SQL NULL，撞 review_events.categories 的 NOT NULL")
	}
	if len(got.Categories) != 0 {
		t.Fatalf("模型没给 categories，实际 %v", got.Categories)
	}
}

// HTTP 错误（可重试）必须与「形状问题」区分开：调用方要据此决定重试还是转人工。
func TestJudgeTransportErrorIsRetryable(t *testing.T) {
	srv := serve(t, `{}`, 500, nil)
	defer srv.Close()
	_, err := Judge(context.Background(), Config{BaseURL: srv.URL, Model: "m", APIKey: "k", Timeout: time.Second}, "p", "t")
	if err == nil {
		t.Fatal("HTTP 500 必须是错误（可重试）")
	}
}

func TestJudgeRefusesWithoutKey(t *testing.T) {
	called := false
	srv := serve(t, toolCall("approve", "x"), 200, func(*http.Request, string) { called = true })
	defer srv.Close()
	if _, err := Judge(context.Background(), Config{BaseURL: srv.URL, Model: "m"}, "p", "t"); err == nil {
		t.Fatal("没配 key 不该外呼")
	}
	if called {
		t.Fatal("没配 key 却发出了请求")
	}
}

// D33③（用户 2026-10-15 拍板，推翻 d7 §11 的「不送图片」）：有图时 user 的 content 必须是
// OpenAI 兼容的**块数组**，图片以 data URL 内联（另一条路要公网可达的图片地址，dev 没有）。
//
// 先红：JudgeImages 不存在时编译不过；只把图接成纯文本（不组块数组）时红在「user.content 不是数组」。
func TestJudgeSendsImageContentParts(t *testing.T) {
	var seen string
	srv := serve(t, toolCall("approve", "没问题"), 200, func(_ *http.Request, body string) { seen = body })
	defer srv.Close()
	raw := []byte{0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4} // 字节是什么不重要：服务端按内容判类型
	_, err := JudgeImages(context.Background(),
		Config{BaseURL: srv.URL, Model: "deepseek-flash", APIKey: "k", Timeout: time.Second},
		"提示词", "标题：看图", []Attachment{{MIME: "image/webp", Data: raw}})
	if err != nil {
		t.Fatal(err)
	}
	msgs := messagesOf(t, seen)
	if len(msgs) != 2 || msgs[0].Role != "system" || msgs[1].Role != "user" {
		t.Fatalf("消息条数/角色不对: %s", seen)
	}
	parts := contentParts(t, msgs[1].Content)
	if len(parts) != 2 {
		t.Fatalf("块数不对（文本 1 + 图 1）: %s", msgs[1].Content)
	}
	if parts[0].Type != "text" || parts[0].Text != "标题：看图" {
		t.Fatalf("第一块该是正文文本，实际 %+v", parts[0])
	}
	want := "data:image/webp;base64," + base64.StdEncoding.EncodeToString(raw)
	if parts[1].Type != "image_url" || parts[1].ImageURL.URL != want {
		t.Fatalf("第二块该是内联 data URL:\n得到 %+v\n想要 %s", parts[1], want)
	}
}

// 无图帖的请求体与加多模态之前**逐字同形**：system + 一段纯文本 user。
// 不是为了兼容谁 —— 是为了让「无图」这条路径的形状不随功能上线而变（变了旧日志就要重新解释）。
func TestJudgeKeepsPlainTextUserWithoutImages(t *testing.T) {
	var seen string
	srv := serve(t, toolCall("approve", "没问题"), 200, func(_ *http.Request, body string) { seen = body })
	defer srv.Close()
	if _, err := Judge(context.Background(), Config{BaseURL: srv.URL, Model: "m", APIKey: "k", Timeout: time.Second}, "p", "标题：纯文本"); err != nil {
		t.Fatal(err)
	}
	msgs := messagesOf(t, seen)
	var text string
	if err := json.Unmarshal(msgs[1].Content, &text); err != nil {
		t.Fatalf("无图时 user.content 该是一段纯文本，实际 %s", msgs[1].Content)
	}
	if text != "标题：纯文本" {
		t.Fatalf("user 文本变了: %q", text)
	}
}

type wireMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

func messagesOf(t *testing.T, body string) []wireMessage {
	t.Helper()
	var payload struct {
		Messages []wireMessage `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("请求体不是 JSON: %v", err)
	}
	return payload.Messages
}

type wirePart struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	ImageURL struct {
		URL string `json:"url"`
	} `json:"image_url"`
}

func contentParts(t *testing.T, content json.RawMessage) []wirePart {
	t.Helper()
	var parts []wirePart
	if err := json.Unmarshal(content, &parts); err != nil {
		t.Fatalf("user.content 不是块数组（有图时必须组块）: %s", content)
	}
	return parts
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
