package httpx

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"runtime"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/apperr"
)

const (
	loggerKey = "forummw.logger"
	startKey  = "forummw.start"
)

// RequestID 生成/透传 X-Request-ID，塞进 gin 与 slog。
// 必须是中间件链的第一位：后面的日志与错误响应都要带它。
func RequestIDMiddleware(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(RequestIDHeader)
		if !validRequestID(id) {
			id = newRequestID()
		}
		c.Set(requestIDKey, id)
		c.Writer.Header().Set(RequestIDHeader, id)
		c.Set(loggerKey, log.With("request_id", id))
		c.Set(startKey, time.Now())
		c.Next()
	}
}

// AccessLog 请求结束记一条 Info。跳过探针：它们每 5 秒一次，会把日志淹掉。
func AccessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if p := c.Request.URL.Path; p == "/healthz" || p == "/readyz" {
			return
		}
		attrs := []any{
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", c.Writer.Status(),
			"ip", c.ClientIP(),
		}
		if v, ok := c.Get(startKey); ok {
			if t, ok := v.(time.Time); ok {
				attrs = append(attrs, "ms", time.Since(t).Milliseconds())
			}
		}
		if uid := c.GetInt64(userIDKey); uid > 0 {
			attrs = append(attrs, "user_id", uid)
		}
		Logger(c).Info("req", attrs...)
	}
}

// Recover panic → 500 + 日志（含堆栈）。响应里不出现 panic 内容。
func Recover() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if r := recover(); r != nil {
				Logger(c).Error("panic", "panic", r, "stack", stackTrace())
				Fail(c, apperr.ErrInternal)
			}
		}()
		c.Next()
	}
}

// BodyLimit 按路由限制请求体；不要全局一刀切（v2 §9.6）。
func BodyLimit(n int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, n)
		}
		c.Next()
	}
}

// SetUserID 供 LoadPrincipal（D2）在解析出身份后调用，让访问日志带上 user_id。
func SetUserID(c *gin.Context, id int64) { c.Set(userIDKey, id) }

const userIDKey = "forummw.user_id"

func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 不可用说明进程已经不正常；退化成时间戳也比空串强
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))[:16]
	}
	return hex.EncodeToString(b[:])
}

// 只接受我们自己发的 16 位 hex：外部塞进来的值不写回响应头，避免头注入。
func validRequestID(s string) bool {
	if len(s) != 16 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isHex(s[i]) {
			return false
		}
	}
	return true
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func stackTrace() string {
	buf := make([]byte, 4096)
	n := runtime.Stack(buf, false)
	return string(buf[:n])
}
