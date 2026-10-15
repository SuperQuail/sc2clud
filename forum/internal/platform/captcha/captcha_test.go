package captcha

import (
	"bytes"
	"context"
	"errors"
	"image/png"
	"testing"
	"time"

	"forum/internal/platform/clock"
	"forum/internal/platform/kv"
	"forum/internal/platform/kv/memkv"
)

func newTestService(t *testing.T, at time.Time) (*Service, *clock.Fake, kv.Cache) {
	t.Helper()
	cache := memkv.New(1000)
	clk := &clock.Fake{T: at}
	s, err := New(cache, clk)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s, clk, cache
}

// 出题：id 是 22 字符 base64url、图能解码、答案落在 kv 而不是图里。
func TestIssueReturnsDecodablePNGAndStoresAnswer(t *testing.T) {
	s, _, cache := newTestService(t, time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC))
	id, img, err := s.Issue(context.Background())
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if len(id) != 22 {
		t.Fatalf("id 长度 %d，期望 22（16 字节 base64url 无填充）", len(id))
	}
	decoded, err := png.Decode(bytes.NewReader(img))
	if err != nil {
		t.Fatalf("返回的不是 PNG: %v", err)
	}
	if b := decoded.Bounds(); b.Dx() != width || b.Dy() != height {
		t.Fatalf("图尺寸 %dx%d，期望 %dx%d", b.Dx(), b.Dy(), width, height)
	}
	stored, err := cache.Get(context.Background(), keyOf(id))
	if err != nil {
		t.Fatalf("kv 里没有这道题的答案: %v", err)
	}
	if len(stored) != answerLen {
		t.Fatalf("答案字节数 %d，期望 %d", len(stored), answerLen)
	}
	if bytes.Contains(img, stored) {
		t.Fatal("答案出现在图片字节里 —— 那等于把答案送给用户")
	}
}

// 一次消费：答对也作废。这条是防爆破的核心，必须**先证明它会红**（把 Del 去掉就红）。
func TestVerifyConsumesAnswerOnSuccess(t *testing.T) {
	s, _, cache := newTestService(t, time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC))
	ctx := context.Background()
	id, _, err := s.Issue(ctx)
	if err != nil {
		t.Fatal(err)
	}
	answer := string(mustGet(t, cache, keyOf(id)))

	if err := s.Verify(ctx, id, answer); err != nil {
		t.Fatalf("第一次用对答案应当通过，得到 %v", err)
	}
	if err := s.Verify(ctx, id, answer); !errors.Is(err, ErrWrong) {
		t.Fatalf("同一个答案第二次必须失败，得到 %v", err)
	}
}

func TestVerifyWrongAnswerAndUnknownID(t *testing.T) {
	s, _, cache := newTestService(t, time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC))
	ctx := context.Background()
	id, _, err := s.Issue(ctx)
	if err != nil {
		t.Fatal(err)
	}
	answer := string(mustGet(t, cache, keyOf(id)))
	wrong := "AAAA"
	if wrong == answer {
		wrong = "BBBB"
	}
	if err := s.Verify(ctx, id, wrong); !errors.Is(err, ErrWrong) {
		t.Fatalf("错答案必须 ErrWrong，得到 %v", err)
	}
	// 答错也作废：再拿对答案来也不认。
	if err := s.Verify(ctx, id, answer); !errors.Is(err, ErrWrong) {
		t.Fatalf("答错之后这道题就该没了，得到 %v", err)
	}
	if err := s.Verify(ctx, "不存在的题", answer); !errors.Is(err, ErrWrong) {
		t.Fatalf("未知 id 必须 ErrWrong，得到 %v", err)
	}
	if err := s.Verify(ctx, id, ""); !errors.Is(err, ErrWrong) {
		t.Fatalf("空答案必须 ErrWrong，得到 %v", err)
	}
}

// 大小写与首尾空白不敏感、全宽一律拒（d5-content §7.1；与 dev 2a4a9f2 真机实测口径一致）。
// 答案在 kv 里直接预置成固定字面量：随机答案未必含字母，靠翻转随机串证不了「大小写敏感已死」。
// 每例一道新题 —— Verify 无论对错都把这道题消费掉。
func TestVerifyIsCaseAndSpaceInsensitive(t *testing.T) {
	s, _, cache := newTestService(t, time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC))
	ctx := context.Background()
	cases := []struct {
		stored, answer string
		want           error
	}{
		{"K7M2", "K7M2", nil},       // 原样
		{"K7M2", "k7m2", nil},       // 大题小答
		{"k7m2", "K7M2", nil},       // 小题大答
		{"K7M2", "  k7m2  ", nil},   // 两端空白
		{"K7M2", "Ｋ７Ｍ２", ErrWrong}, // 全宽：形状对不上必须拒（宁拒勿过）
	}
	for _, tc := range cases {
		id, _, err := s.Issue(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := cache.Set(ctx, keyOf(id), []byte(tc.stored), answerTTL); err != nil {
			t.Fatalf("预置答案 %q: %v", tc.stored, err)
		}
		if err := s.Verify(ctx, id, tc.answer); !errors.Is(err, tc.want) {
			t.Fatalf("题面 %q 按 %q 作答：得到 %v，想要 %v", tc.stored, tc.answer, err, tc.want)
		}
	}
}

// kv 挂了必须拒绝，而不是静默通过（d5-content §7.2：宁可拒绝登录）。
func TestVerifyFailsClosedWhenCacheUnavailable(t *testing.T) {
	s, err := New(downCache{}, &clock.Fake{T: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Verify(context.Background(), "x", "ABCD"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("kv 不可用时必须是 ErrUnavailable（拒绝放行），得到 %v", err)
	}
}

// ── 三模式 ────────────────────────────────────────────────────────

func TestRequiredFollowsMode(t *testing.T) {
	s, clk, _ := newTestService(t, time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC))
	ctx := context.Background()
	const ip = "10.0.0.9"

	if s.Required(ctx, ip, ModeAlways) != true {
		t.Fatal("always 必须每次都要求")
	}
	if s.Required(ctx, ip, ModeOff) != false {
		t.Fatal("off 不该要求")
	}
	if s.Required(ctx, "什么乱写的值", "sometimes") != false {
		t.Fatal("未知 mode 必须按 off 兜底（不是 panic、不是要求）")
	}

	// on_failure：第 5 次失败之前不要求。
	for i := 0; i < failThreshold-1; i++ {
		s.CountFailure(ctx, ip)
		if s.Required(ctx, ip, ModeOnFailure) {
			t.Fatalf("第 %d 次失败后就要求验证码了，阈值是 %d", i+1, failThreshold)
		}
	}
	s.CountFailure(ctx, ip)
	if !s.Required(ctx, ip, ModeOnFailure) {
		t.Fatalf("第 %d 次失败后必须要求验证码", failThreshold)
	}
	// 别的 IP 不受影响。
	if s.Required(ctx, "10.0.0.10", ModeOnFailure) {
		t.Fatal("失败计数必须按 IP 分开")
	}
	// 成功清零。
	s.ResetFailures(ctx, ip)
	if s.Required(ctx, ip, ModeOnFailure) {
		t.Fatal("成功之后必须清零，否则正常用户会被永远要求验证码")
	}
	// 窗口过期：10 分钟内的才算「连续」。
	for i := 0; i < failThreshold; i++ {
		s.CountFailure(ctx, ip)
	}
	clk.T = clk.T.Add(failWindow + time.Second)
	if s.Required(ctx, ip, ModeOnFailure) {
		t.Fatal("超过 10 分钟的失败不该再算数")
	}
}

// 数窗口的边界要**先证明会红**：把窗口判断写成 now.Sub(t) <= failWindow 这条就会红。
func TestFailureWindowBoundary(t *testing.T) {
	s, clk, _ := newTestService(t, time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC))
	ctx := context.Background()
	const ip = "10.0.0.11"
	for i := 0; i < failThreshold; i++ {
		s.CountFailure(ctx, ip)
	}
	// 窗口内（差一秒到 10 分钟）仍然算。
	clk.T = clk.T.Add(failWindow - time.Second)
	if !s.Required(ctx, ip, ModeOnFailure) {
		t.Fatal("窗口内必须仍然算失败")
	}
	// 整整 10 分钟那一刻：必须过期。边界写成 <= 这条就会红（已变异验证过）。
	clk.T = clk.T.Add(time.Second)
	if s.Required(ctx, ip, ModeOnFailure) {
		t.Fatal("满 10 分钟的失败必须过期")
	}
}

func mustGet(t *testing.T, c kv.Cache, key string) []byte {
	t.Helper()
	b, err := c.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("读 kv %s: %v", key, err)
	}
	return b
}

// downCache 模拟 Redis 挂掉：Get/Set 都返回 ErrUnavailable。
type downCache struct{}

func (downCache) Get(context.Context, string) ([]byte, error) { return nil, kv.ErrUnavailable }
func (downCache) Set(context.Context, string, []byte, time.Duration) error {
	return kv.ErrUnavailable
}
func (downCache) Del(context.Context, ...string) error { return kv.ErrUnavailable }
