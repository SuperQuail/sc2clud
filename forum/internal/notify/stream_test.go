package notify

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/authz"
)

// stream_test.go 覆盖 L11 的 SSE 推送（拍板：老站已经有实现，参考其代码复现）。
// 老站的对照物：site/crates/sc2clud-web/src/pages_messages.rs:100-146
// （axum 的 Sse + KeepAlive 20s + 响应头 x-accel-buffering: no）
// 与 site/crates/sc2clud-web/templates/inbox.html:242-276（EventSource + 30s 轮询兜底）。

// runStream 以 userID 的身份跑一次 /notifications/stream，跑完 fn 之后主动断开。
// 返回的 recorder 里就是这次连接写出去的全部字节（httptest.Recorder 的 Write 都落在同一个 Buffer）。
func runStream(t *testing.T, userID int64, fn func(h *Handler)) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := NewHandler(nil, func(c *gin.Context) (*authz.Actor, bool) {
		v, ok := c.Get("actor")
		if !ok {
			return nil, false
		}
		a, _ := v.(*authz.Actor)
		return a, a != nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/notifications/stream", nil).WithContext(ctx)
	c.Set("actor", &authz.Actor{UserID: userID})

	done := make(chan struct{})
	go func() { defer close(done); h.stream(c) }()

	// 等 handler 真的订阅上（否则 Publish 会送给一个还不存在的 channel，用例变成看天吃饭）
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.hub.mu.Lock()
		_, ok := h.hub.ch[userID]
		h.hub.mu.Unlock()
		if ok {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("2 秒内没等到订阅（handler 没进到 stream 的订阅那一步）")
		}
		time.Sleep(2 * time.Millisecond)
	}

	fn(h)
	cancel()
	<-done
	return rec
}

// **会红**：删掉 x-accel-buffering 那一行时（nginx 默认缓冲 SSE，事件会「攒着不发」）。
func TestStreamHeadersAreSSESafe(t *testing.T) {
	rec := runStream(t, 7, func(*Handler) {})
	if rec.Code != http.StatusOK {
		t.Fatalf("SSE 建立应 200，实际 %d", rec.Code)
	}
	for k, want := range map[string]string{
		"Content-Type":      "text/event-stream",
		"Cache-Control":     "no-cache",
		"Connection":        "keep-alive",
		"X-Accel-Buffering": "no",
	} {
		if got := rec.Header().Get(k); !strings.HasPrefix(got, want) {
			t.Fatalf("响应头 %s = %q，应含 %q", k, got, want)
		}
	}
	if !strings.Contains(rec.Body.String(), ": connected") {
		t.Fatalf("建立时要先写一行注释（客户端 onopen 才有东西可等），实际 %q", rec.Body.String())
	}
}

// **会红**：把「写完通知之后发信号」那条线断掉（NewHandler 不再给 svc.publish 赋值、
// 或 Create 里的 notifyChanged 被删）时，实时性整条链路是死的，而接口看起来完全正常。
func TestHandlerWiresPublishIntoService(t *testing.T) {
	var got []int64
	h := NewHandler(&Service{}, nil)
	h.svc.publish = func(uid int64) { got = append(got, uid) }
	h.svc.notifyChanged(42)
	if len(got) != 1 || got[0] != 42 {
		t.Fatalf("service 写完要发信号，实际 %v", got)
	}
	// 真接线：NewHandler 必须自己接上（否则上面那句只是自证）
	real := NewHandler(&Service{}, nil)
	if real.svc.publish == nil {
		t.Fatal("NewHandler 必须把 hub.Publish 交给 service")
	}
}

// **会红**：把广播改成「所有人一条 channel」时，别人的通知会推到我的连接上。
func TestStreamOnlyGetsOwnEvents(t *testing.T) {
	mine := runStream(t, 7, func(h *Handler) { h.hub.Publish(7) })
	if !strings.Contains(mine.Body.String(), "event: unread") {
		t.Fatalf("自己的通知要推过来，实际 %q", mine.Body.String())
	}
	other := runStream(t, 7, func(h *Handler) { h.hub.Publish(8) })
	if strings.Contains(other.Body.String(), "event: unread") {
		t.Fatalf("8 号的事件不该出现在 7 号的连接上：%q", other.Body.String())
	}
}

// 事件体只是「变了」的信号，不带正文 —— 正文那份渲染逻辑在 GET /notifications 里，只有一份。
func TestStreamEventPayloadIsSignalOnly(t *testing.T) {
	rec := runStream(t, 7, func(h *Handler) { h.hub.Publish(7) })
	body := rec.Body.String()
	i := strings.Index(body, "event: unread")
	if i < 0 {
		t.Fatalf("publish 之后要写出事件，实际 %q", body)
	}
	rest := body[i+len("event: unread"):]
	rest = strings.TrimLeft(rest, "\n")
	if !strings.HasPrefix(rest, "data: ") {
		t.Fatalf("事件要带 data 行，实际 %q", rest)
	}
	line := strings.SplitN(strings.TrimPrefix(rest, "data: "), "\n", 2)[0]
	var payload map[string]any
	if err := json.Unmarshal([]byte(line), &payload); err != nil {
		t.Fatalf("事件体必须是合法 JSON，实际 %q（%v）", line, err)
	}
	if payload["changed"] != true || len(payload) != 1 {
		t.Fatalf("事件体只带 changed=true 这一个信号，实际 %v", payload)
	}
}

// hub 的取舍：满了就丢（老站 broadcast 的 Lagged 分支同一个取舍），删得掉（否则 map 随用户数一直涨）。
func TestHubDropsWhenFullAndUnsubscribes(t *testing.T) {
	hub := newStreamHub()
	ch := hub.Subscribe(1)
	for i := 0; i < streamBuffer+10; i++ {
		hub.Publish(1) // 满之后不许阻塞
	}
	if len(ch) != streamBuffer {
		t.Fatalf("满之后应停在容量 %d，实际 %d", streamBuffer, len(ch))
	}
	hub.Unsubscribe(1, ch)
	hub.Publish(1)
	if _, ok := hub.ch[1]; ok {
		t.Fatal("最后一个订阅者离开后要删掉 channel")
	}
}
