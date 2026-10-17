package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// argon2id：参数、PHC 串、rehash 判定（设计 §7.3）。
// 并发上限是硬要求（方案 §9.1）：10 个并发哈希在 2GB 机器上是 320MB 瞬时分配。
type argon2Params struct {
	Time    uint32
	Memory  uint32 // KiB
	Threads uint8
	KeyLen  uint32
}

// dummyPHC 是一条真实算出来的 argon2id 串（明文 "auth-dummy-password"）。
// 登录时账号不存在也拿它走一次校验，让「存在」与「不存在」的响应时间接近（设计 §7.2 第 3 步）。
// 它不是任何人的密码：这个哈希只在本文件里出现，没有任何账号用它。
const dummyPHC = "$argon2id$v=19$m=32768,t=2,p=2$YXV0aC1kdW1teS1zYWx0$3ZC1sQ0nQ0hQ0k8m5oP0n8GZ2bq0mQm7K0k8m5oP0n8"

// hasher 是 argon2id 的唯一入口：哈希、校验、rehash 判定与并发信号量都在这里。
type hasher struct {
	p    argon2Params
	sem  chan struct{}
	wait time.Duration
	log  *slog.Logger
}

func newHasher(p argon2Params, maxConcur int, wait time.Duration, log *slog.Logger) *hasher {
	if maxConcur <= 0 {
		maxConcur = 2
	}
	if wait <= 0 {
		wait = 3 * time.Second
	}
	return &hasher{p: p, sem: make(chan struct{}, maxConcur), wait: wait, log: log}
}

func (h *hasher) acquire(ctx context.Context) error {
	t := time.NewTimer(h.wait)
	defer t.Stop()
	select {
	case h.sem <- struct{}{}:
		return nil
	case <-t.C:
		h.log.Warn("argon2 信号量等待超时", "in_flight", len(h.sem), "wait", h.wait.String())
		return ErrHashBusy
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *hasher) release() { <-h.sem }

// Hash 算一个新 PHC 串。调用方负责先 acquire / defer release（哈希算完才释放）。
func (h *hasher) Hash(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, h.p.Time, h.p.Memory, h.p.Threads, h.p.KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, h.p.Memory, h.p.Time, h.p.Threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// Verify 校验 PHC 串。解析失败（旧站占位值 "!"）恒返回 false，**不 panic、不加无密码登录分支**。
func (h *hasher) Verify(phc, password string) bool {
	p, salt, want, err := parsePHC(phc)
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummy 走一次与真实校验同参数的哈希与比较，只为消耗同样的时间。
func (h *hasher) dummy(password string) { h.Verify(dummyPHC, password) }

// needsRehash：旧串比当前参数弱就要在登录成功时升级（旧站是 m=19456,t=2,p=1）。
// 解析失败返回 false——那种账号根本走不到这里，校验已经失败了。
func (h *hasher) needsRehash(phc string) bool {
	p, salt, key, err := parsePHC(phc)
	if err != nil {
		return false
	}
	cur := h.p
	return p.Memory < cur.Memory || p.Time < cur.Time || p.Threads != cur.Threads ||
		len(salt) < 16 || uint32(len(key)) != cur.KeyLen
}

// parsePHC 拆 $argon2id$v=19$m=..,t=..,p=..$salt$hash。
// 只认 argon2id：argon2i / argon2d 是别的算法，落进这里说明串被改过。
func parsePHC(phc string) (argon2Params, []byte, []byte, error) {
	parts := strings.Split(phc, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return argon2Params{}, nil, nil, errors.New("auth: 不是 argon2id PHC 串")
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return argon2Params{}, nil, nil, errors.New("auth: PHC 版本不支持")
	}
	var p argon2Params
	var threads uint32
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Time, &threads); err != nil {
		return argon2Params{}, nil, nil, errors.New("auth: PHC 参数不可解析")
	}
	if p.Memory == 0 || p.Time == 0 || threads == 0 {
		// argon2.IDKey 在参数为 0 时 panic：畸形串必须在进它之前被挡住。
		return argon2Params{}, nil, nil, errors.New("auth: PHC 参数为 0")
	}
	p.Threads = uint8(threads)
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return argon2Params{}, nil, nil, errors.New("auth: PHC salt 不可解码")
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return argon2Params{}, nil, nil, errors.New("auth: PHC key 不可解码")
	}
	p.KeyLen = uint32(len(key))
	return p, salt, key, nil
}

var _ = strconv.Itoa
