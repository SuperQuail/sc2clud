package httpx

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"
)

// Probe 是 /healthz 与 /readyz 的唯一实现。
// 探针不带 /api/v1 前缀、不挂 LoadPrincipal（别白查一次库），也不写访问日志。
type Probe struct {
	Version    string
	WebVersion string
	Checks     []Check
}

// Check 是一个依赖探测；Ready 失败时 /readyz 返回 503，Degraded 失败只标记 degraded。
type Check struct {
	Name     string
	Ready    bool // true 时失败即 503
	Degraded bool // true 时失败只标记 degraded（仍 200）
	Run      func(ctx context.Context) error
}

// Register 挂上两个探针路由。
func (p *Probe) Register(r gin.IRouter) {
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "version": p.Version, "web_version": p.WebVersion})
	})
	r.GET("/readyz", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()

		checks := gin.H{}
		status := "ok"
		httpStatus := 200
		for _, ck := range p.Checks {
			if ck.Run == nil {
				checks[ck.Name] = "skipped"
				continue
			}
			if err := ck.Run(ctx); err != nil {
				checks[ck.Name] = "down"
				switch {
				case ck.Ready:
					status, httpStatus = "unavailable", 503
				case ck.Degraded:
					if status == "ok" {
						status = "degraded"
					}
				}
				continue
			}
			checks[ck.Name] = "ok"
		}
		c.JSON(httpStatus, gin.H{"status": status, "checks": checks})
	})
}
