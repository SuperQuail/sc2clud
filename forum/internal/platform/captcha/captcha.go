// Package captcha 是图形验证码：出一道题、校验一次答案，以及「这个 IP 现在要不要验证码」的策略。
// 依据：后端设计 d5-content.md §7（接口与常量）与 d2-auth.md §9.5（限流键）。
//
// 三样「验证码」不要混（拍板 §11.6）：邮箱验证码在 email_tokens（auth 域）、
// 图形验证码在这里、会话 token 在 sessions。
package captcha

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	mrand "math/rand"
	"strings"
	"sync"
	"time"

	"forum/internal/platform/clock"
	"forum/internal/platform/kv"
)

// 常量写死在包里，**不进配置**（d5-content §7.2）：放配置里就会有人把阈值调成 100，等于关掉。
const (
	answerLen     = 4
	answerTTL     = 5 * time.Minute
	failThreshold = 5
	failWindow    = 10 * time.Minute
	maxFailKeys   = 10000
)

// 三种模式（config.Captcha.Mode 的取值域，validate.go 里校验）。
const (
	ModeOff       = "off"
	ModeOnFailure = "on_failure"
	ModeAlways    = "always"
)

var (
	// ErrWrong：答案不对，或者这道题不存在 / 已过期 / 已被消费。
	// 三种情况对外**必须一样**：区分只会泄漏「这个 id 存在过」（d5-content §7.2）。
	ErrWrong = errors.New("captcha: wrong")
	// ErrUnavailable：kv 连不上。调用方必须拒绝放行，不许静默取消人机验证（d5-content §7.2）。
	ErrUnavailable = errors.New("captcha: unavailable")
)

// Service 是唯一的实现。并发安全（handler 并发调用它）。
type Service struct {
	cache kv.Cache
	clk   clock.Clock
	// rnd 只画图（抖动与噪点）；**答案与 id 走 crypto/rand**，不是它。
	rnd *mrand.Rand
	// rndMu 保护 rnd：*rand.Rand 不是并发安全的。
	rndMu sync.Mutex

	// failMu/fail 是「连续失败次数」的落点。设计里它写在 kv（captcha:fail:<ip>），
	// 但 kv.Cache **没有原子自增**（今天已记录在案：email.go 的 attemptGuard 同因），
	// 而 auth 复用它去读旧值时必然与自增打架（先读后写 => 计数会漂）。
	// 所以照本仓库已有的 attemptGuard 形状落在进程内：
	//   - 代价：多实例部署时每个实例各数各的（最坏 N×5 次才要求验证码），重启即清零；
	//   - 好处：不新增 kv 方法、不引入新依赖，且能配合 clock.Fake 断言窗口过期。
	// shortcut: 计数是进程内的；要跨实例一致就必须给 kv 加原子自增（或补一张表）。
	failMu sync.Mutex
	fail   map[string][]time.Time
}

func New(cache kv.Cache, clk clock.Clock) (*Service, error) {
	if cache == nil {
		return nil, errors.New("captcha: 需要 kv.Cache")
	}
	if clk == nil {
		clk = clock.Real{}
	}
	return &Service{cache: cache, clk: clk, rnd: mrand.New(mrand.NewSource(randomSeed())), fail: map[string][]time.Time{}}, nil
}

// Issue 下发一道题：返回 id 与 PNG 字节。答案写进 kv，TTL 5 分钟。
// 答案**绝不回传**（响应里只有 id + 图片），也不进日志。
func (s *Service) Issue(ctx context.Context) (id string, png []byte, err error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	id = base64.RawURLEncoding.EncodeToString(raw) // 22 字符、不可枚举、不复用不递增

	s.rndMu.Lock()
	answer := newAnswer(s.rnd)
	png, err = renderPNG(answer, s.rnd)
	s.rndMu.Unlock()
	if err != nil {
		return "", nil, err
	}
	// 存的是答案字节：答案是 4 个 ASCII 字符，直接当 []byte 存，不引序列化。
	if err := s.cache.Set(ctx, keyOf(id), []byte(answer), answerTTL); err != nil {
		return "", nil, fmt.Errorf("captcha: 存答案: %w", err)
	}
	return id, png, nil
}

// Verify 校验一次答案：**无论对错都立刻 Del**（一道题只有一次机会，防爆破）。
// 比较前 TrimsSpace + ToUpper（答案不区分大小写）。
func (s *Service) Verify(ctx context.Context, id, answer string) error {
	if id == "" || answer == "" {
		return ErrWrong
	}
	stored, err := s.cache.Get(ctx, keyOf(id))
	switch {
	case errors.Is(err, kv.ErrNotFound):
		return ErrWrong // 不存在 / 已过期 / 已被消费：对外都是「这道题没了」
	case err != nil:
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}

	// 拿到就先删：不管下面比出什么结果，这道题都不再可用。
	_ = s.cache.Del(ctx, keyOf(id))

	want := strings.ToUpper(strings.TrimSpace(string(stored)))
	got := strings.ToUpper(strings.TrimSpace(answer))
	if subtle.ConstantTimeCompare([]byte(want), []byte(got)) != 1 {
		return ErrWrong
	}
	return nil
}

// Required 回答「这个 IP 现在要不要验证码」。
//
//   - off：不要求（注册有邮箱验证兜底、登录有限流兜底）；
//   - on_failure：同一 IP 10 分钟内失败 ≥5 次之后才要求；
//   - always：每次都要求。
//
// 未知取值按 off —— config.Validate 已经挡过，这里再兜一次不 panic：一个拼错的 mode
// 让整站登录 500，比按默认值走糟得多。
func (s *Service) Required(_ context.Context, ip, mode string) bool {
	switch mode {
	case ModeAlways:
		return true
	case ModeOnFailure:
		return s.count(ip) >= failThreshold
	default:
		return false
	}
}

// CountFailure 记一次「登录/注册失败」。值 = 窗口内的失败次数，窗口 10 分钟。
func (s *Service) CountFailure(_ context.Context, ip string) {
	s.failMu.Lock()
	defer s.failMu.Unlock()
	now := s.clk.Now()
	s.fail[ip] = append(prune(s.fail[ip], now), now)
	if len(s.fail) > maxFailKeys { // 键太多说明有人在乱试：整体清空比内存无限涨好
		s.fail = map[string][]time.Time{ip: s.fail[ip]}
	}
}

// ResetFailures 清零：登录/注册**成功**时调用。「连续失败」的定义要求成功清零，
// 否则一个正常用户偶尔打错也会被永远要求验证码（d5-content §7.2）。
func (s *Service) ResetFailures(_ context.Context, ip string) {
	s.failMu.Lock()
	defer s.failMu.Unlock()
	delete(s.fail, ip)
}

// count 数窗口内的失败次数。读操作也顺手清理过期项，所以它不需要后台清扫。
func (s *Service) count(ip string) int {
	s.failMu.Lock()
	defer s.failMu.Unlock()
	kept := prune(s.fail[ip], s.clk.Now())
	if len(kept) == 0 {
		delete(s.fail, ip)
		return 0
	}
	s.fail[ip] = kept
	return len(kept)
}

// prune 丢掉窗口之外的时刻。原地复用底层数组。
func prune(ts []time.Time, now time.Time) []time.Time {
	live := ts[:0]
	for _, t := range ts {
		if now.Sub(t) < failWindow {
			live = append(live, t)
		}
	}
	return live
}

func keyOf(id string) string { return "captcha:" + id }

// randomSeed 取 crypto/rand 的 8 字节做 math/rand 种子：画图不需要密码学强度，
// 但种子不能用时间——同一秒起两个进程会画出同一张图。
func randomSeed() int64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().UnixNano()
	}
	var n int64
	for _, x := range b {
		n = n<<8 | int64(x)
	}
	return n
}
