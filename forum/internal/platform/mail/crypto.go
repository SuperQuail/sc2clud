package mail

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/chacha20poly1305"
)

// 主密钥的环境变量名。主密钥只从环境变量来：不进库、不进 yaml、不进备份。
// 32 字节 hex（64 个字符）。换密钥时把旧密钥放 KeyEnvOld，构成解密链。
const (
	KeyEnv    = "FORUM_MAIL__KEY"
	KeyEnvOld = "FORUM_MAIL__OLD_KEYS" // 逗号分隔，新的在前
)

// Crypter 加解密发信凭据（chacha20poly1305，AEAD）。
//
// AAD 用账号的 public_id：密文与「它属于哪一行」绑死，把密文粘到别的账号上解不开。
// 不做密钥版本号列：解密链靠 oldKeys 的尝试顺序表达（新的先试），多一列就多一处要同步。
type Crypter struct {
	keys [][]byte // keys[0] 是当前加密用密钥
}

// NewCrypter 解析 hex 密钥。key 必须是 32 字节；oldKeys 可为空。
func NewCrypter(key string, oldKeys ...string) (*Crypter, error) {
	k, err := parseKey(key)
	if err != nil {
		return nil, fmt.Errorf("mail: 主密钥（%s）: %w", KeyEnv, err)
	}
	keys := [][]byte{k}
	for i, old := range oldKeys {
		if strings.TrimSpace(old) == "" {
			continue
		}
		ok, err := parseKey(old)
		if err != nil {
			return nil, fmt.Errorf("mail: 旧主密钥 #%d（%s）: %w", i+1, KeyEnvOld, err)
		}
		keys = append(keys, ok)
	}
	return &Crypter{keys: keys}, nil
}

func parseKey(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return nil, fmt.Errorf("不是十六进制: %w", err)
	}
	if len(b) != chacha20poly1305.KeySize {
		return nil, fmt.Errorf("必须是 %d 字节（%d 个十六进制字符），实际 %d 字节",
			chacha20poly1305.KeySize, chacha20poly1305.KeySize*2, len(b))
	}
	return b, nil
}

// Encrypt 用当前密钥加密。nonce 必须与密文一起存（表里有 secret_nonce 列）。
func (c *Crypter) Encrypt(plain, aad []byte) (ciphertext, nonce []byte, err error) {
	aead, err := chacha20poly1305.New(c.keys[0])
	if err != nil {
		return nil, nil, fmt.Errorf("mail: aead: %w", err)
	}
	nonce = make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, fmt.Errorf("mail: nonce: %w", err)
	}
	return aead.Seal(nil, nonce, plain, aad), nonce, nil
}

// ErrCantDecrypt 表示这份凭据用当前与所有旧密钥都解不开。
// Router 把它当成「跳过这个账号」，不是致命错误：补上 KeyEnvOld 重启即可恢复（d6 §8.4）。
var ErrCantDecrypt = errors.New("mail: 凭据解不开")

// Decrypt 依次试当前密钥与所有旧密钥。
func (c *Crypter) Decrypt(ciphertext, nonce, aad []byte) ([]byte, error) {
	for _, key := range c.keys {
		aead, err := chacha20poly1305.New(key)
		if err != nil {
			return nil, fmt.Errorf("mail: aead: %w", err)
		}
		if len(nonce) != aead.NonceSize() {
			return nil, fmt.Errorf("mail: nonce 长度 %d，想要 %d", len(nonce), aead.NonceSize())
		}
		plain, err := aead.Open(nil, nonce, ciphertext, aad)
		if err == nil {
			return plain, nil
		}
	}
	return nil, ErrCantDecrypt
}
