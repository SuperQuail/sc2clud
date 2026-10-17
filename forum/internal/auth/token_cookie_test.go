package auth

// Cookie 的 Secure 按「请求实际协议」推导的钉子（2026-10-15 用户实测）。
// 老逻辑按 base_url 推导（prod 是 https 域名），IP 明文访问时浏览器按规范直接丢弃
// Secure cookie —— 登录成功也看不到会话。四条：明文 IP / 可信代理 XFP / 伪造 XFP / 直连 TLS。
import (
  "crypto/tls"
  "net/http"
  "net/http/httptest"
  "testing"

  "github.com/gin-gonic/gin"

  "forum/internal/config"
)

func TestRequestIsHTTPSMatrix(t *testing.T) {
  svc := &Service{cfg: &config.Config{}}
  svc.cfg.HTTP.TrustedProxies = []string{"127.0.0.1"}

  c := func(remote, xfp string, directTLS bool) *gin.Context {
    ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
    ctx.Request = httptest.NewRequest(http.MethodPost, "/", nil)
    ctx.Request.RemoteAddr = remote
    if xfp != "" {
      ctx.Request.Header.Set("X-Forwarded-Proto", xfp)
    }
    if directTLS {
      ctx.Request.TLS = &tls.ConnectionState{}
    }
    return ctx
  }

  if svc.requestIsHTTPS(c("203.0.113.9:44444", "", false)) {
    t.Fatalf("IP 明文访问不该是 Secure —— 这就是「登录后仍未登录」的根因")
  }
  if !svc.requestIsHTTPS(c("127.0.0.1:55555", "https", false)) {
    t.Fatalf("可信代理的 XFP=https 应当是 Secure（域名走 nginx TLS）")
  }
  if svc.requestIsHTTPS(c("127.0.0.1:55555", "http", false)) {
    t.Fatalf("可信代理的 XFP=http 应当不是 Secure")
  }
  if svc.requestIsHTTPS(c("203.0.113.9:44444", "https", false)) {
    t.Fatalf("非可信对端伪造的 XFP 不算数")
  }
  if !svc.requestIsHTTPS(c("203.0.113.9:44444", "", true)) {
    t.Fatalf("直连 TLS 应当是 Secure")
  }

  svc.cfg.HTTP.TrustedProxies = nil
  if svc.requestIsHTTPS(c("127.0.0.1:55555", "https", false)) {
    t.Fatalf("没配可信代理时不该信任 XFP")
  }
}
