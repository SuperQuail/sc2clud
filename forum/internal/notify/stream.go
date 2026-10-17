package notify

import (
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// SSE（Server-Sent Events）—— 拍板 L11「老站已经有实现,参考其代码复现即可」。
//
// 老站的实现（site/crates/sc2clud-web/src/pages_messages.rs:100-146、templates/inbox.html:242-276）：
//   - 服务端 axum::response::sse::Sse + 一条进程内 tokio::broadcast（容量 256，满了 Lagged 就跳过），
//     KeepAlive 20s，并在响应头写 x-accel-buffering: no（**nginx 默认缓冲 SSE，不关就是「攒着不发」**）；
//   - 客户端 EventSource 为主，另有 setInterval(pull, 30000) 轮询兜底
//     （老站自己的账：单进程够用，多实例要换跨进程，或靠轮询兜底 —— site/AGENTS.md §9 末行）。
//
// 这一版照抄这三件事，只换传输内容：
//   1. 一条进程内广播（本文件），容量与老站一样 256；
//   2. keep-alive 15s（**必须小于 http.Server.WriteTimeout = 30s**，config/defaults.go:21 ——
//      写超时是整条响应的，不写东西就会被服务端掐掉）；
//   3. 客户端仍以 EventSource 为主 + 30s 轮询兜底（web/src/routes/messages.tsx）。
//
// 一条与老站**故意不同**的地方：老站推的是消息正文（它要就地追加气泡），这里推的是
// 「你的未读数可能变了」这个信号（不推正文）。理由：通知列表要按 kind 分档、要读 payload、
// 要判 actor 是否注销 —— 那套逻辑已经在 GET /notifications 里了，再写一份必然漂移
// （交接单 §5.1 的最高频事故形态）。前端收到信号就重取一次角标与当前档的列表。
//
// 「可能变了」这四个字是认真的：通知写入发生在**别人的事务里**（notify.Create 用调用方的事务，
// d4 §4.4），而这里只有一个进程内的信号，没有提交后回调。所以信号可能早于提交到达 ——
// 前端重取时若还没提交，那次重取什么也看不到；它不会因此丢事件，因为下一次信号（或 30s 轮询兜底）会再来一次。
// 这条取舍换来的是「不必改动 9 个域的写路径」，与老站把 broadcast 放在 send 之后是同一个量级的近似。

// streamHub 是进程内的一对多广播：按 user_id 各一条 channel（容量 256，同老站）。
// 没有订阅者时不分配 channel（写入侧只是查一次 map，与老站的 send() 无人接收即丢弃等价）。
type streamHub struct {
	mu sync.Mutex
	ch map[int64]chan struct{}
}

func newStreamHub() *streamHub { return &streamHub{ch: map[int64]chan struct{}{}} }

// Subscribe 拿一条只收通道。调用方负责在请求结束时 Unsubscribe。
func (h *streamHub) Subscribe(userID int64) chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch, ok := h.ch[userID]
	if !ok {
		ch = make(chan struct{}, streamBuffer)
		h.ch[userID] = ch
	}
	return ch
}

// Unsubscribe 在最后一个订阅者离开时把 channel 删掉（否则 map 会随用户数一直涨）。
func (h *streamHub) Unsubscribe(userID int64, ch chan struct{}) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cur, ok := h.ch[userID]; ok && cur == ch {
		delete(h.ch, userID)
	}
}

// Publish 是非阻塞的：满了就丢掉这一次信号（老站的 Lagged 分支同一个取舍）——
// 前端那边是「重取一次」，多一次少一次都不影响最终一致。
func (h *streamHub) Publish(userID int64) {
	h.mu.Lock()
	ch, ok := h.ch[userID]
	h.mu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

const (
	// 与老站同容量（site/crates/sc2clud-web/src/lib.rs:90 的 broadcast::channel(256)）。
	streamBuffer = 256
	// keepAlive < http.Server.WriteTimeout（默认 30s）：不写东西就会被服务端掐掉。
	keepAlive = 15 * time.Second
)

// stream 是 GET /notifications/stream。
//
// 认证走的是同一条 requireLogin 中间件（EventSource 不带自定义头，但会带 Cookie ——
// 同源请求，credentials 默认 same-origin 就够）。
func (h *Handler) stream(c *gin.Context) {
	actor, _ := h.actorOf(c)
	if actor == nil {
		// Register 已经把它挂在 requireLogin 下面；走到这里说明接线错了
		c.Status(http.StatusUnauthorized)
		return
	}
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		// gin 的 ResponseWriter 一定是 Flusher；真不是就别假装能推
		c.Status(http.StatusInternalServerError)
		return
	}

	ch := h.hub.Subscribe(actor.UserID)
	defer h.hub.Unsubscribe(actor.UserID, ch)

	head := c.Writer.Header()
	head.Set("Content-Type", "text/event-stream; charset=utf-8")
	head.Set("Cache-Control", "no-cache")
	head.Set("Connection", "keep-alive")
	// nginx 默认缓冲响应：SSE 会「攒着不发」（老站同一处，pages_messages.rs:140-144）。
	head.Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	// 先把响应头推出去：客户端 onopen 才知道连上了（也是「这一条真的建立了」的证据）。
	c.Writer.Write([]byte(": connected\n\n"))
	flusher.Flush()

	ticker := time.NewTicker(keepAlive)
	defer ticker.Stop()

	for {
		select {
		case <-c.Request.Context().Done():
			// 客户端断开 / 服务端关闭：正常路径，不是错误
			return
		case <-ticker.C:
			// 注释行（以 ':' 开头）不触发任何事件，只为把连接与写超时续上
			if _, err := c.Writer.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		case <-ch:
			if err := writeUnreadEvent(c.Writer); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// writeUnreadEvent 只发一个信号，不带正文（理由见文件头）。
func writeUnreadEvent(w io.Writer) error {
	payload, err := json.Marshal(gin.H{"changed": true})
	if err != nil {
		return err
	}
	_, err = w.Write([]byte("event: unread\ndata: " + string(payload) + "\n\n"))
	return err
}
