package ai

import (
	"context"
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
		// 只断言**这个 SDK 真能发出去**的字段。
		// ⚠️ 已知偏差：d7 要求 temperature=0，而 go-openai 的字段是 float32+omitempty，传 0 会被丢掉。
		// 换成官方 openai/openai-go（param.Opt 能显式表达「传了 0」）后，这里要加回 "temperature":0 的断言。
		for _, key := range []string{"tools", "submit_review", "max_tokens"} {
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

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
