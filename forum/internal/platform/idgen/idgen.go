// Package idgen 生成对外 ID 与随机 token。
// 对外 ID 一律 UUID v7（时间有序，索引友好）；DB 不设默认值，值由写库前生成。
package idgen

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"

	"github.com/google/uuid"
)

// NewPublicID 生成一个 UUID v7。
func NewPublicID() (uuid.UUID, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, fmt.Errorf("idgen: new v7: %w", err)
	}
	return id, nil
}

// NewToken 生成 n 字节随机 token，base64url 无填充。
// 库里只存它的 SHA-256（D2），明文只在 Cookie / 邮件链接里出现一次。
func NewToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("idgen: rand: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ParsePublicID 解析 URL / 请求体里的对外 ID。
// 返回裸错误而不是 apperr：platform 不认识业务错误码，转换由各 service 做。
func ParsePublicID(s string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, fmt.Errorf("idgen: parse public id: %w", err)
	}
	return id, nil
}
