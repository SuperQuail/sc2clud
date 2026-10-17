package auth

import (
	"encoding/base64"
	"fmt"
	"testing"
	"time"

	"golang.org/x/crypto/argon2"
)

// 这条钉的是**迁移侧唯一未验证的点**：老 Rust 站的口令串能不能被新站校验通过。
//
// 老库的串是 `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<key>`（比新站弱），
// 新站 verifier 从**串里**读参数重算，所以按分析是能过的 —— 但「分析上能」不算验证。
// 这里用老参数真的造一条串，看 Verify 收不收；顺带钉住「登录成功后会 rehash 升级」。
func TestLegacyArgon2idHashVerifies(t *testing.T) {
	const password = "old-site-password-2026"
	salt := []byte("legacy-salt-16by") // 老串的 salt 是 16 字节
	const mem, timeCost uint32 = 19456, 2
	const threads uint8 = 1
	key := argon2.IDKey([]byte(password), salt, timeCost, mem, threads, 32)
	legacy := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, mem, timeCost, threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key))

	// 新站的参数（比老站强）
	h := newHasher(argon2Params{Time: 2, Memory: 32768, Threads: 2, KeyLen: 32}, 4, 5*time.Second, nil)

	if !h.Verify(legacy, password) {
		t.Fatal("老站参数的口令串必须能通过新站校验 —— 否则迁移过来的用户全部登不上")
	}
	if h.Verify(legacy, password+"x") {
		t.Fatal("错口令不能通过")
	}
	if !h.needsRehash(legacy) {
		t.Fatal("老串比新参数弱，登录成功后必须 rehash 升级")
	}
	// 旧站占位值（不可登录的种子账号）必须是 false，而且不能 panic
	if h.Verify("!", "whatever") {
		t.Fatal("占位串恒为 false")
	}
}
