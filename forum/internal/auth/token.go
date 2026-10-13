package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// defaultSessionTTL 兜底：配置没给时用 30 天（设计 §6.1）。
const defaultSessionTTL = 720 * time.Hour

func (s *Service) sessionTTL() time.Duration {
	if s.cfg.Auth.SessionTTL > 0 {
		return s.cfg.Auth.SessionTTL
	}
	return defaultSessionTTL
}

// newToken 生成 32 字节 crypto/rand 的 base64url 串（43 字符）。
// 它只在 Cookie 里出现一次，库里存的是**这个串**的 SHA-256（设计 §6.1）。
//
// 摘要算的是编码后的串，不是 32 字节原文：客户端手上只有串，服务端每次都要从串重算摘要，
// 两边必须用同一个输入（写错一次就是「刚登录的会话解析不出来」）。
func newToken() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("auth: token: %w", err)
	}
	tok := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(tok))
	return tok, sum[:], nil
}

// digestOf 算会话摘要（库里存的 32 字节）。解析路径每次请求都要算一次，绕不开。
func digestOf(raw string) []byte {
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}

// newCSRF 是随 Principal 下发、会话里稳定存一份的值（方案 §9.3）。
func newCSRF() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: csrf: %w", err)
	}
	return fmt.Sprintf("%x", raw), nil
}

// newNumericCode 生成 6 位数字验证码。**必须用 crypto/rand**（拍板 §11.4）。
// 4 字节取模 1e6 的偏置约 4e-10，对一次性验证码没有意义。
func newNumericCode() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("auth: code: %w", err)
	}
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(b[:])%1_000_000), nil
}

// codeHash 是验证码与重置票据入库前的摘要（拍板 §11.3：库里不存明文）。
func codeHash(code string) []byte {
	sum := sha256.Sum256([]byte(code))
	return sum[:]
}

// 会话 Cookie 的属性写死在一处（设计 §6.1）：HttpOnly 永远开，Secure 按 base_url 的协议，
// SameSite=Lax、Path=/、Max-Age=session_ttl。默认同域部署，前端用不到 csrf（方案 §9.3）。
func (s *Service) setSessionCookie(c *gin.Context, token string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     s.cfg.Site.CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(s.sessionTTL().Seconds()),
		HttpOnly: true,
		Secure:   s.secureCookie(),
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearCookie 把会话 Cookie 清掉。解析失败、登出、改密码都要走它。
func (s *Service) ClearCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     s.cfg.Site.CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secureCookie(),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) secureCookie() bool {
	const https = "https://"
	return len(s.cfg.Site.BaseURL) >= len(https) && s.cfg.Site.BaseURL[:len(https)] == https
}

// 会话列表与踢设备的 {id}：token_hash 的 base64url **全文**（32 字节 → 43 字符）。
//
// sessions 表**没有 public_id 列**（ent 的 session schema 明确写了「不加 public_id 是定案」，
// 与拍板 U13 的②相反），所以对外 id 只能是摘要的编码。**必须是全文而不是前缀**：
// 截断的前缀既让「踢设备」查不到行，也会让两条会话撞同一个 id。
func sessionKey(digest []byte) string {
	return base64.RawURLEncoding.EncodeToString(digest)
}

// decodeSessionKey 把 {id} 解回 32 字节摘要——它**就是** uq_sessions_token 的查询键。
func decodeSessionKey(key string) ([]byte, bool) {
	b, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil || len(b) != 32 {
		return nil, false
	}
	return b, true
}
