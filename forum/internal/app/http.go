package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"forum/internal/auth"
	"forum/internal/config"
	"forum/internal/forum"
	"forum/internal/mail"
	"forum/internal/media"
	"forum/internal/message"
	"forum/internal/notify"
	"forum/internal/platform/db"
	"forum/internal/platform/httpx"
	"forum/internal/release"
	"forum/internal/report"
	"forum/internal/reward"
	"forum/internal/site"
	"forum/internal/title"
	"forum/internal/user"
)

// HTTPServer 把 gin 引擎与 http.Server 绑在一起，供 run 的关闭流程使用。
type HTTPServer struct {
	Engine *gin.Engine
	Srv    *http.Server
}

// newHTTPServer 建引擎、挂中间件与路由。顺序写死（d1 §4.3）：
// requestid → accesslog → recover → （LoadPrincipal：D2）→ ratelimit → Perm → handler。
func newHTTPServer(cfg *config.Config, in *Infra, m *Modules, bi BuildInfo) (*HTTPServer, error) {
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

	registerAPIRoutes(r, cfg, m)

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

// registerAPIRoutes 把各域的路由挂到 /api/v1 上。
//
// 这里**只写路由**：依赖细节（谁实现谁的 deps.go、各域的中间件工厂）全在 modules.go。
// auth 先挂：它自己 v1.Use(LoadPrincipal)，其余域的路由都要排在它后面才拿得到身份。
func registerAPIRoutes(r *gin.Engine, cfg *config.Config, m *Modules) {
	v1 := r.Group("/api/v1", httpx.BodyLimit(cfg.HTTP.BodyLimit()))

	// 图片读路径不在 /api/v1 下（d5 §1.4）：/img/<hash>。游客可读，可见性在 service 里判。
	mediaHandler := media.NewHandler(m.Media, auth.FromGin)
	r.GET("/img/:hash", mediaHandler.ServeImage)

	// 认证与会话（含 /me 与 /admin 的角色权限）。
	auth.NewHandler(m.Auth).Register(v1)
	// 公开资料：/users/search 与 /users/:handle。
	user.NewHandler(m.User).Register(v1)

	forum.NewHandler(m.Forum, actorOf).Register(v1, m.requireLogin(), m.perm1)
	mediaHandler.Register(v1, m.requireLoginFn, m.perm, httpx.BodyLimit)
	release.NewHandler(m.Release, auth.FromGin).Register(v1, m.requireLoginFn, m.perm)
	reward.NewHandler(m.Reward, auth.FromGin).Register(v1, m.requireLoginFn, m.perm, m.limit)
	notify.NewHandler(m.Notify, auth.FromGin).Register(v1, m.requireLogin())
	message.NewHandler(m.Message, auth.FromGin).Register(v1, m.requireLogin())
	title.NewHandler(m.Title, m.titleUsers(), auth.FromGin).Register(v1, m.requireLogin(), m.perm)
	site.NewHandler(m.Site, auth.FromGin).Register(v1, m.requireLogin, m.perm)
	mail.NewHandler(m.Mail, auth.FromGin).Register(v1, m.requireLogin, m.perm)
	report.NewHandler(m.Report, auth.FromGin).Register(v1, m.requireLogin, m.perm, m.limit)
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
