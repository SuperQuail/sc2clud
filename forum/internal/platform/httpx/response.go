// Package httpx 是 HTTP 层的唯一出口：响应包络、请求绑定、中间件。
// 依据：完全重构/后端设计/d1-platform.md §4 与 v2 §21.1。
package httpx

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"syscall"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"

	"forum/internal/platform/apperr"
)

const requestIDKey = "forummw.request_id"

// RequestIDHeader 是链路标识的响应头，也是入口透传用的请求头。
const RequestIDHeader = "X-Request-ID"

// OK 写 200 {"data": v}。
func OK(c *gin.Context, v any) {
	c.JSON(http.StatusOK, gin.H{"data": v})
}

// Created 写 201 {"data": v}。
func Created(c *gin.Context, v any) {
	c.JSON(http.StatusCreated, gin.H{"data": v})
}

// OKList 写 200 {"data": [...], "next_cursor": string|null}。
// next 为空串时输出 null——前端按 null 判「到底」。
// items 为 nil 时输出 []：空数组与 null 是两种东西，zod 的 z.array() 只接受前者。
func OKList(c *gin.Context, items any, next string) {
	if next == "" {
		c.JSON(http.StatusOK, gin.H{"data": items, "next_cursor": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": items, "next_cursor": next})
}

// OKListCounts 是 OKList 加一个 counts（整个筛选结果集的计数，不是本页条数）。
//
// 为什么计数与列表同一次请求给出：分两次（列表一次、count 一次）时，两次之间有人注册，
// 屏上就会出现「列表 21 条、总数 20」——两个数都来自真查询，读起来却自相矛盾。
func OKListCounts(c *gin.Context, items any, next string, counts any) {
	if next == "" {
		c.JSON(http.StatusOK, gin.H{"data": items, "next_cursor": nil, "counts": counts})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": items, "next_cursor": next, "counts": counts})
}

// NoContent 写 204。没有响应体，所以没有包络。
func NoContent(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

// Fail 是 handler 唯一的错误出口。
//
//  1. *apperr.Error        → 用它（带 fields 时一起写）
//  2. context.Canceled     → 499，只记 Debug（客户端断开不是服务端故障）
//  3. 参数超限 / 超时      → 对应码（413 / 408）
//  4. 连不上数据库         → 500 common.internal +「数据库连接不可用」
//  5. 其它                 → 500 common.internal：认识的 SQLSTATE 说清是哪一类，
//     其余用 ErrInternal 的笼统句；细节只进日志
func Fail(c *gin.Context, err error) {
	if err == nil {
		return
	}
	log := Logger(c)
	reqID := RequestID(c)

	var ae *apperr.Error
	if errors.As(err, &ae) {
		body := gin.H{"code": ae.Code, "message": ae.Msg, "request_id": reqID}
		if len(ae.Fields) > 0 {
			body["fields"] = ae.Fields
		}
		// 5xx（服务端故障）记 Error，4xx（调用方的问题）记 Info：否则日志会被 404/401 淹掉
		if ae.Status >= 500 {
			log.Error("http fail", "err", err.Error(), "status", ae.Status, "code", ae.Code)
		} else {
			log.Info("http fail", "code", ae.Code, "status", ae.Status)
		}
		c.AbortWithStatusJSON(ae.Status, gin.H{"error": body})
		return
	}

	if errors.Is(err, context.Canceled) {
		log.Debug("http canceled", "err", err.Error())
		c.AbortWithStatusJSON(499, gin.H{"error": gin.H{
			"code": "common.canceled", "message": "请求已取消", "request_id": reqID,
		}})
		return
	}

	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		Fail(c, apperr.ErrTooLarge)
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		log.Warn("http timeout", "err", err.Error())
		c.AbortWithStatusJSON(http.StatusRequestTimeout, gin.H{"error": gin.H{
			"code": "common.timeout", "message": "请求超时", "request_id": reqID,
		}})
		return
	}
	// 连不上数据库：底层是 *net.OpError，必须在下面按「客户端提前断开」吞成 200 空响应之前认出来
	if dbUnavailable(err) {
		log.Error("db unavailable", "err", err.Error())
		Fail(c, apperr.ErrInternal.WithMsg("数据库连接不可用，请稍后重试"))
		return
	}
	// 客户端在写响应前就断了：不是服务端故障，也不该记 Error
	if errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) || isClosedConn(err) {
		log.Debug("http conn closed", "err", err.Error())
		c.Abort()
		return
	}

	log.Error("internal error", "err", err.Error())
	// 对外只说归类后的那句话：内部信息（表名/约束名/SQL）不出响应体
	Fail(c, internalError(err))
}

// pgReasons 是 SQLSTATE → 中文原因。D70：线上保存来源撞 ck_topic_sources_size（23514）时，
// 用户只看到「（错误编号 …）」、真实原因只在日志里 —— 只给编号等于没给原因。
var pgReasons = map[string]string{
	"23505": "已有相同记录（唯一约束冲突）",
	"23503": "关联的数据不存在",
	"23514": "数据不满足字段约束",
	"23502": "必填字段为空",
	"22P02": "参数格式不正确",
	"40001": "并发冲突，请重试",
	"40P01": "并发冲突，请重试",
	"57014": "查询超时",
}

// internalError 把未识别的错误翻成对外那句话：认识的说清是哪一类，其余交给 ErrInternal 的笼统句。
// code / status 一律照旧（契约不动）。
func internalError(err error) *apperr.Error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		if reason, ok := pgReasons[pg.Code]; ok {
			return apperr.ErrInternal.WithMsg(reason)
		}
	}
	return apperr.ErrInternal
}

// dbUnavailable 认「连不上数据库」：pgx 拨号失败给 *pgconn.ConnectError，服务端说连接异常时给 08 类。
func dbUnavailable(err error) bool {
	var ce *pgconn.ConnectError
	if errors.As(err, &ce) {
		return true
	}
	var pg *pgconn.PgError
	return errors.As(err, &pg) && strings.HasPrefix(pg.Code, "08")
}

func isClosedConn(err error) bool {
	var ne *net.OpError
	return errors.As(err, &ne)
}

// Logger 返回挂在引擎上的 slog（RequestID 中间件之前也可能被调用，所以有兜底）。
func Logger(c *gin.Context) *slog.Logger {
	if v, ok := c.Get(loggerKey); ok {
		if l, ok := v.(*slog.Logger); ok {
			return l
		}
	}
	return slog.Default()
}

// RequestID 取当前请求的 request_id；没有则空串。
func RequestID(c *gin.Context) string {
	if v, ok := c.Get(requestIDKey); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
