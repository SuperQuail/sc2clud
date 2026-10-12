package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/config"
	"forum/internal/platform/db"
	"forum/internal/platform/httpx"
)

// HTTPServer 把 gin 引擎与 http.Server 绑在一起，供 run 的关闭流程使用。
type HTTPServer struct {
	Engine *gin.Engine
	Srv    *http.Server
}

// newHTTPServer 建引擎、挂中间件与路由。顺序写死（d1 §4.3）：
// requestid → accesslog → recover → （LoadPrincipal：D2）→ ratelimit → Perm → handler。
func newHTTPServer(cfg *config.Config, in *Infra, bi BuildInfo) (*HTTPServer, error) {
	if cfg.Env == "prod" {
		gin.SetMode(gin.ReleaseMode)
	}
	// 不用 gin.Default()：它自带 Logger/Recovery，与本设计的中间件重复
	r := gin.New()
	// 必须调：不设可信代理时 c.ClientIP() 可以被 X-Forwarded-For 伪造，限流就失效了
	if err := r.SetTrustedProxies(cfg.HTTP.TrustedProxies); err != nil {
		return nil, fmt.Errorf("http: set trusted proxies: %w", err)
	}

	r.Use(httpx.RequestIDMiddleware(in.Log))
	r.Use(httpx.AccessLog())
	r.Use(httpx.Recover())

	probe := &httpx.Probe{
		Version:    bi.Version,
		WebVersion: bi.WebVersion(),
		Checks: []httpx.Check{
			{Name: "db", Ready: true, Run: func(ctx context.Context) error {
				return db.Ping(ctx, in.Pool)
			}},
		},
	}
	probe.Register(r)

	registerAPIRoutes(r, cfg, in)

	if err := registerStatic(r, cfg, bi); err != nil {
		return nil, err
	}

	srv := &http.Server{
		Addr:              cfg.HTTP.Addr,
		Handler:           r,
		ReadHeaderTimeout: cfg.HTTP.ReadHeaderTimeout,
		ReadTimeout:       cfg.HTTP.ReadTimeout,
		WriteTimeout:      cfg.HTTP.WriteTimeout,
		IdleTimeout:       cfg.HTTP.IdleTimeout,
		MaxHeaderBytes:    cfg.HTTP.MaxHeaderBytes,
	}
	return &HTTPServer{Engine: r, Srv: srv}, nil
}

// registerAPIRoutes 挂 /api/v1 下的路由。
// P0 只有分组本身；D2/D3 的业务路由按同样的形状挂上来（handler.Register(rg)）。
func registerAPIRoutes(r *gin.Engine, cfg *config.Config, in *Infra) {
	v1 := r.Group("/api/v1", httpx.BodyLimit(cfg.HTTP.BodyLimit()))
	_ = v1
	_ = in
}

// registerStatic 挂静态托管与 SPA 回退。
// web.serve_shell=false 时什么都不挂（本地用 Vite 提供 shell）。
// 生产由 nginx 直出 /assets/，那时把 web.serve_assets 设成 false。
func registerStatic(r *gin.Engine, cfg *config.Config, bi BuildInfo) error {
	if !cfg.Web.ServeShell && !cfg.Web.ServeAssets {
		return nil
	}
	shell, err := NewShell(bi.WebDir, cfg.Web.BasePath)
	if err != nil {
		return err
	}
	handler, err := httpx.Static(bi.WebDir, cfg.Web.ServeAssets, shell.Handler())
	if err != nil {
		return err
	}
	r.NoRoute(handler)
	return nil
}

// shutdownTimeout 给优雅关闭一个统一预算（HTTP 停止接收新请求的上限）。
func shutdownTimeout(cfg *config.Config) time.Duration {
	if cfg.HTTP.ShutdownTimeout > 0 {
		return cfg.HTTP.ShutdownTimeout
	}
	return 15 * time.Second
}
