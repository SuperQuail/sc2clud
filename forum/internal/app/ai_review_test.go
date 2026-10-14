package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"forum/internal/config"
)

// 四条硬性质（不需要真 key、不需要数据库）。前三条都在文档里写着：
//  1. 没配 key 时**一个外呼都不发**（上线最容易出的事故就是没配好时猛打别人的 API）；
//  2. 请求里必须带 **tools**（我们靠工具调用拿判定，不是让模型回 JSON 再猜）；
//  3. **finish_reason=length 必须当成失败**（文档明写 max_tokens 太小会截断，截断的判定不能用）；
//  4. 认不出的工具名**不能**被当成通过。
func TestAIReviewNeverCallsWithoutKey(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	in := &Infra{Log: slog.Default(), AI: config.AI{Enabled: true, Key: "", Endpoint: srv.URL, Model: "m", Timeout: time.Second}}
	if _, err := aiReviewOnce(context.Background(), in, "文本"); err == nil {
		t.Fatal("没配 key 时不该真的外呼")
	}
	if called {
		t.Fatal("没配 key 却发出了请求")
	}
}

func toolCallResponse(name, args string) string {
	b, _ := json.Marshal(map[string]any{
		"choices": []any{map[string]any{
			"finish_reason": "tool_calls",
			"message": map[string]any{
				"role": "assistant",
				"tool_calls": []any{map[string]any{
					"id": "call_1", "type": "function",
					"function": map[string]any{"name": name, "arguments": args},
				}},
			},
		}},
	})
	return string(b)
}

func TestAIReviewUsesToolCalls(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		if r.URL.Path != "/chat/completions" {
			t.Errorf("base_url 照文档就是 api.deepseek.com，SDK 自己拼 /chat/completions；实际 %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("Authorization 头不对: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(toolCallResponse("reject_post", `{"reason":"含广告引流"}`)))
	}))
	defer srv.Close()

	in := &Infra{Log: slog.Default(), AI: config.AI{Enabled: true, Key: "test-key", Endpoint: srv.URL, Model: "deepseek-flash", MaxTokens: 2048, Timeout: time.Second}}
	got, err := aiReviewOnce(context.Background(), in, "【帖子】\n标题：x")
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Verdict) != "reject" || got.Reason != "含广告引流" {
		t.Fatalf("判定解析错了: %+v", got)
	}
	for _, want := range []string{"\"tools\"", "approve_post", "pending_post", "reject_post", "max_tokens"} {
		if !strings.Contains(body, want) {
			t.Fatalf("请求体里缺少 %s：\n%s", want, body)
		}
	}
}

func TestAIReviewRejectsTruncatedOutput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{
			"finish_reason": "length",
			"message":       map[string]any{"role": "assistant", "content": ""},
		}}})
		w.Write(b)
	}))
	defer srv.Close()

	in := &Infra{Log: slog.Default(), AI: config.AI{Enabled: true, Key: "k", Endpoint: srv.URL, Model: "m", Timeout: time.Second}}
	if _, err := aiReviewOnce(context.Background(), in, "文本"); err == nil {
		t.Fatal("被 max_tokens 截断的输出必须当失败 —— 文档明写会截断")
	}
}

func TestAIReviewRejectsUnknownTool(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(toolCallResponse("delete_everything", `{}`)))
	}))
	defer srv.Close()

	in := &Infra{Log: slog.Default(), AI: config.AI{Enabled: true, Key: "k", Endpoint: srv.URL, Model: "m", Timeout: time.Second}}
	if _, err := aiReviewOnce(context.Background(), in, "文本"); err == nil {
		t.Fatal("认不出的工具名不能被当成判定")
	}
}
