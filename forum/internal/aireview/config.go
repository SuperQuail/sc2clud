// Package aireview 是 AI 审核域（d7-ai-review.md）。
//
// 定位：**AI 是第一道审核，人是最后一道**。它不是独立业务线，而是审核队列的一个判定来源 ——
// 读写的是 forum 的主题状态（review_state / review_note / review_source），并把每一次判定记进 review_events。
//
// 三条铁律（d7 §1）：① AI 不删内容（最多把 visibility 置 hidden）；② AI 失败不阻塞发帖（任务退避后交人工）；
// ③ 同一篇主题的 AI 调用有上限。以及一条幂等：**AI 绝不覆盖人工判定**。
package aireview

import (
	"context"
	"errors"
	"time"
)

// Crypter 是密钥加解密（与发信凭据**同一套**、同一把主密钥 —— d7 §2.1）。由 app 注入实现。
type Crypter interface {
	Encrypt(plain, aad []byte) (ciphertext, nonce []byte, err error)
	Decrypt(ciphertext, nonce, aad []byte) ([]byte, error)
}

// aadAIKey 是密钥加密的附加认证数据：与 mail 用 public_id 同构，这里单行表用一个固定串。
var aadAIKey = []byte("ai_config:1")

// Config 是 ai_config 单行表（d7 §2.1）的读视图。**永不含密钥明文**。
type Config struct {
	Enabled         bool
	Provider        string
	BaseURL         string
	Model           string
	Thinking        bool
	StrictMode      bool
	Prompt          string
	PromptReport    string
	Temperature     float64
	TimeoutMS       int
	MaxOutputTokens int
	HasSecret       bool
	// 三个时刻用 *time.Time：ts 列直接扫进来，线格式的 RFC3339 由 dto.go 的 rfc3339 转。
	SecretUpdatedAt *time.Time
	LastOKAt        *time.Time
	LastError       string
	LastErrorAt     *time.Time
}

// GetConfig 读单行配置（语句全在 sql.go：同一个域不做第二份 SQL）。
func (s *Service) GetConfig(ctx context.Context) (*Config, error) {
	var c Config
	err := s.pool.QueryRow(ctx, sqlSelectConfig).Scan(
		&c.Enabled, &c.Provider, &c.BaseURL, &c.Model, &c.Thinking, &c.StrictMode, &c.Prompt, &c.PromptReport,
		&c.Temperature, &c.TimeoutMS, &c.MaxOutputTokens,
		&c.HasSecret, &c.SecretUpdatedAt, &c.LastOKAt, &c.LastError, &c.LastErrorAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// LoadKey 解出密钥（只在真正要外呼时调；**任何返回值都不进 API、不进日志**）。
func (s *Service) LoadKey(ctx context.Context) (string, error) {
	var cipher, nonce []byte
	err := s.pool.QueryRow(ctx, sqlSelectSecret).Scan(&cipher, &nonce)
	if err != nil {
		return "", err
	}
	if len(cipher) == 0 {
		return "", errors.New("aireview: 还没配 API Key")
	}
	plain, err := s.crypter.Decrypt(cipher, nonce, aadAIKey)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// SaveKey 写入密钥（写成功要清掉 last_error：换了 key 之后旧的错误不再代表现状）。
func (s *Service) SaveKey(ctx context.Context, plain string) error {
	cipher, nonce, err := s.crypter.Encrypt([]byte(plain), aadAIKey)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, sqlSaveSecret, cipher, nonce)
	return err
}

// UpdateConfig 只写传进来的字段（nil = 不动）。
func (s *Service) UpdateConfig(ctx context.Context, in ConfigInput) error {
	_, err := s.pool.Exec(ctx, sqlUpdateConfig,
		in.Enabled, in.Provider, in.BaseURL, in.Model, in.Thinking, in.StrictMode,
		in.Prompt, in.PromptReport, in.Temperature, in.TimeoutMS, in.MaxOutputTokens)
	return err
}

// markOK / markError 是 d7 §7 的用量与失败率数据来源。
func (s *Service) markOK(ctx context.Context) {
	_, _ = s.pool.Exec(ctx, sqlMarkOK)
}

// markError 只记 AI 自己的失败（d7 §7 的失败率数据源）。按**字符**截断：这是个中文错误串，
// 按字节切会把一个汉字砍成半个（trimRunes 的注释）。
func (s *Service) markError(ctx context.Context, msg string) {
	_, _ = s.pool.Exec(ctx, sqlMarkError, trimRunes(msg, 500))
}
