// Package testkit 是**给别的包的测试用**的小件。
//
// 为什么存在：有些替身要跨包使用（例如 app 包的 e2e 需要一个「不算图也认得出答案」的图形验证码）。
// 放在某个 _test.go 里是共享不了的（Go 的测试文件不跨包），放在被替身替换的那个包的生产文件里
// 又会把测试专用代码混进制品 —— 所以单独一个小包，只被 _test.go 引用。
package testkit

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"forum/internal/platform/captcha"
)

// CaptchaStub 是 platform/captcha 的替身：**只认它自己发过的那几个 id**，
// 答错给 captcha.ErrWrong（与真出题器同一个错误），未知 id 给 captcha.ErrWrong（对外同一个码）。
//
// 与真出题器的差别写在明处：它不画图、答案由调用方指定、id 可预测。
// 因此它**只能**用于「验证码这一环不是被测对象」的用例（e2e 的主链路正是如此）。
type CaptchaStub struct {
	mu      sync.Mutex
	seq     int
	answers map[string]string
}

func NewCaptchaStub() *CaptchaStub {
	return &CaptchaStub{answers: map[string]string{}}
}

// Issue 造一道题并记下答案，返回可预测的 id（cap-1、cap-2…）。
//
// 序号用独立的计数器、**不用 len(answers)+1**：Verify 会把用过的题删掉，
// 用长度当序号会让两张不同的题拿到同一个 id（第一张还没用、第二张就把它的答案覆盖了）——
// 那正是「同一个 id 两张题」的经典错，也是这套替身唯一容易写错的地方。
func (s *CaptchaStub) Issue() (string, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	id := fmt.Sprintf("cap-%d", s.seq)
	answer := "ABCD"
	s.answers[id] = answer
	return id, answer
}

// Verify 与真出题器同语义：**一道题只有一次机会**（不管对错都消费掉），
// 比较前 TrimSpace + ToUpper（答案不区分大小写）。
func (s *CaptchaStub) Verify(_ context.Context, id, answer string) error {
	s.mu.Lock()
	want, ok := s.answers[id]
	if ok {
		delete(s.answers, id)
	}
	s.mu.Unlock()
	if !ok {
		return captcha.ErrWrong // 不存在 / 已过期 / 已被消费：对外都是「这道题没了」
	}
	if !strings.EqualFold(strings.TrimSpace(want), strings.TrimSpace(answer)) {
		return captcha.ErrWrong
	}
	return nil
}
