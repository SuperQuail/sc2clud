package app

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"forum/internal/config"
)

// AI 审核的两条硬性质（不需要真 key、不需要数据库）：
//  1. **没配 key 时一个外呼都不发** —— 上线时最容易出的事故就是在没配好的情况下猛打别人的 API；
//  2. 模型的回答**带 ```json 围栏也要能解析**（各家实现不一致，这条不然会在生产里随机失败）。
func TestAIReviewNeverCallsWithoutKey(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.Write([]byte(`{"choices":[{"message":{"content":"{\"ok\":true}"}}]}`))
	}))
	defer srv.Close()

	// key 为空 = 不启用：连一次请求都不该发出去。
	in := &Infra{Log: slog.Default(), AI: config.AI{Enabled: true, Key: "", Endpoint: srv.URL, Model: "m", Timeout: time.Second}}
	if _, err := aiJudge(context.Background(), in, "标题", "正文"); err == nil {
		t.Fatal("没配 key 时不该真的外呼")
	}
	if called {
		t.Fatal("没配 key 却发出了请求")
	}
}

func TestAIJudgeParsesFencedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("Authorization 头不对: %q", r.Header.Get("Authorization"))
		}
		// 故意带围栏：模型经常这么回。
		w.Write([]byte("{\"choices\":[{\"message\":{\"content\":\"```json\\n{\\\"ok\\\":false,\\\"reason\\\":\\\"含广告引流\\\"}\\n```\"}}]}"))
	}))
	defer srv.Close()

	in := &Infra{Log: slog.Default(), AI: config.AI{Enabled: true, Key: "test-key", Endpoint: srv.URL, Model: "m", Timeout: time.Second}}
	v, err := aiJudge(context.Background(), in, "标题", "正文")
	if err != nil {
		t.Fatal(err)
	}
	if v.OK {
		t.Fatal("围栏 JSON 里的 ok=false 应当被解析出来")
	}
	if v.Reason != "含广告引流" {
		t.Fatalf("reason 应为「含广告引流」，实际 %q", v.Reason)
	}
}
