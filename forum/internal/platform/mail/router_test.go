package mail

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

const (
	tzSH  = "Asia/Shanghai"
	tzUTC = "UTC"
)

func msg() Message { return Message{To: "a@b.c", Subject: "s", HTML: "<p>x</p>", Text: "x"} }

// 一次成功的投递：占 1 次额度，并把「占的是哪个账号的哪一天」写回投递记录。
func TestSendAcquiresQuotaOnce(t *testing.T) {
	h := newHarness(t)
	id := h.newAccount("main", "log", 10, 5, tzUTC)

	if err := h.r.Send(h.ctx, msg()); err != nil {
		t.Fatal(err)
	}
	if n := h.quotaCount(id, "2026-10-13"); n != 1 {
		t.Fatalf("额度 = %d, 想要 1", n)
	}
	if len(h.store.bound) != 1 || h.store.bound[0] != fmt.Sprintf("%d@2026-10-13", id) {
		t.Fatalf("新占额度必须写回投递记录，实际 %v", h.store.bound)
	}
	if h.store.oks != 1 {
		t.Fatalf("成功投递要记一次 last_ok，实际 %d", h.store.oks)
	}
}

// 拍板的核心语义：额度按**一次投递**算，不按一次尝试算。
func TestRetryDoesNotConsumeQuotaTwice(t *testing.T) {
	h := newHarness(t)
	id := h.newAccount("main", "log", 10, 5, tzUTC)

	// ① 第一次投递成功：占 1 次额度，并把占用写回投递记录。
	if err := h.r.Send(h.ctx, msg()); err != nil {
		t.Fatal(err)
	}
	if n := h.quotaCount(id, "2026-10-13"); n != 1 {
		t.Fatalf("额度 = %d, 想要 1", n)
	}
	if len(h.store.bound) != 1 {
		t.Fatalf("成功投递必须写回占用，实际 %v", h.store.bound)
	}

	// ② 队列重试（比如发完之后进程被杀）：带上记录里的 quota_account_id / quota_day，
	//    复用同一份额度，不得再 +1，也不再写回。
	held := Hold{AccountID: id, Day: time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)}
	if err := h.r.Send(h.ctx, msg(), WithHeld(held)); err != nil {
		t.Fatalf("重试应当成功: %v", err)
	}
	if n := h.quotaCount(id, "2026-10-13"); n != 1 {
		t.Fatalf("重试不得再占额度，实际 = %d", n)
	}
	if len(h.store.bound) != 1 {
		t.Fatalf("复用不该再写回，实际 %v", h.store.bound)
	}

	// ③ 跨过账号午夜后那份 Hold 过期：按新占处理，新的一天 +1。
	h.clk.T = h.clk.T.Add(24 * time.Hour)
	if err := h.r.Send(h.ctx, msg(), WithHeld(held)); err != nil {
		t.Fatalf("跨天重试应当成功: %v", err)
	}
	if n := h.quotaCount(id, "2026-10-14"); n != 1 {
		t.Fatalf("新一天的额度 = %d, 想要 1", n)
	}
	if len(h.store.bound) != 2 {
		t.Fatalf("跨天后要重新写回，实际 %v", h.store.bound)
	}
}

// 失败的那次尝试不会写回占用（信没发出去，没有投递记录可写）——
// 代价是「第一次占的那次额度白占」，v2 §8.3 明确接受这种一次性损耗；
// 真正的浪费（重试 5 次占 5 次）被 WithHeld 掐掉。
func TestFailedAttemptLeavesQuotaHeld(t *testing.T) {
	h := newHarness(t)
	id := h.newAccount("main", "log", 10, 5, tzUTC)
	h.prov.errs = []error{fmt.Errorf("%w: 连接超时", ErrTemporary)}

	if err := h.r.Send(h.ctx, msg()); !errors.Is(err, ErrTemporary) {
		t.Fatalf("想要 ErrTemporary，实际 %v", err)
	}
	if n := h.quotaCount(id, "2026-10-13"); n != 1 {
		t.Fatalf("失败也占过一次额度（这是设计接受的），实际 %d", n)
	}
	if len(h.store.bound) != 0 {
		t.Fatalf("没发成功就不该写回，实际 %v", h.store.bound)
	}
}

// 跨过账号 reset_tz 的午夜：额度是新一天的，要重新占（这就是「按自然日重置」）。
func TestQuotaResetsAcrossAccountMidnight(t *testing.T) {
	h := newHarness(t)
	id := h.newAccount("main", "log", 10, 5, tzSH)
	buf := &fakeStore{}
	h.r.store = buf

	// UTC 2026-10-13 12:00 = 上海 20:00 → 额度日记在 10-13。
	if err := h.r.Send(h.ctx, msg()); err != nil {
		t.Fatal(err)
	}
	if n := h.quotaCount(id, "2026-10-13"); n != 1 {
		t.Fatalf("上海 10-13 的额度 = %d, 想要 1", n)
	}

	// UTC 2026-10-13 17:00 = 上海 10-14 01:00 → 新的一天。
	h.clk.T = h.clk.T.Add(5 * time.Hour)
	if err := h.r.Send(h.ctx, msg()); err != nil {
		t.Fatal(err)
	}
	if n := h.quotaCount(id, "2026-10-14"); n != 1 {
		t.Fatalf("上海 10-14 的额度 = %d, 想要 1", n)
	}
	if got := buf.bound; len(got) != 2 || got[1] != fmt.Sprintf("%d@2026-10-14", id) {
		t.Fatalf("跨天后必须重新写回，实际 %v", got)
	}
}

// 额度满了要换下一个账号（按 priority 降序），并且不超卖。
func TestQuotaFullFallsBackToNextAccount(t *testing.T) {
	h := newHarness(t)
	high := h.newAccount("primary", "log", 10, 1, tzUTC)
	low := h.newAccount("backup", "log", 1, 1, tzUTC)

	if err := h.r.Send(h.ctx, msg()); err != nil {
		t.Fatal(err)
	}
	if n := h.quotaCount(high, "2026-10-13"); n != 1 {
		t.Fatalf("优先账号该被先用满，实际 %d", n)
	}
	// 第二次：优先账号额度满 → 换 backup。
	if err := h.r.Send(h.ctx, msg()); err != nil {
		t.Fatal(err)
	}
	if n := h.quotaCount(high, "2026-10-13"); n != 1 {
		t.Fatalf("额度满的账号不该再加，实际 %d", n)
	}
	if n := h.quotaCount(low, "2026-10-13"); n != 1 {
		t.Fatalf("应当轮到 backup，实际 %d", n)
	}
}

// 所有账号都没额度 → ErrNoProvider（调用方据此把任务排到下一个重置点）。
func TestNoQuotaReturnsErrNoProvider(t *testing.T) {
	h := newHarness(t)
	h.newAccount("only", "log", 1, 1, tzUTC)

	if err := h.r.Send(h.ctx, msg()); err != nil {
		t.Fatal(err)
	}
	err := h.r.Send(h.ctx, msg())
	if !errors.Is(err, ErrNoProvider) {
		t.Fatalf("想要 ErrNoProvider，实际 %v", err)
	}
}

// ErrPermanent 不换账号（换也没用），而且要把错误原样回上去。
func TestPermanentErrorGivesUp(t *testing.T) {
	h := newHarness(t)
	h.newAccount("a", "log", 10, 5, tzUTC)
	h.newAccount("b", "log", 1, 5, tzUTC)
	h.prov.errs = []error{fmt.Errorf("%w: 收件人不存在", ErrPermanent)}

	err := h.r.Send(h.ctx, msg())
	if !errors.Is(err, ErrPermanent) {
		t.Fatalf("想要 ErrPermanent，实际 %v", err)
	}
	if h.prov.n != 1 {
		t.Fatalf("永久失败不该换账号重试，实际投递 %d 次", h.prov.n)
	}
}

// 账号抛 ErrQuotaExceeded（对方限流）→ 换下一个账号，而不是直接失败。
func TestProviderQuotaExceededSwitchesAccount(t *testing.T) {
	h := newHarness(t)
	h.newAccount("a", "log", 10, 5, tzUTC)
	h.newAccount("b", "log", 1, 5, tzUTC)
	h.prov.errs = []error{fmt.Errorf("%w: 429", ErrQuotaExceeded)}

	if err := h.r.Send(h.ctx, msg()); err != nil {
		t.Fatal(err)
	}
	if h.prov.n != 2 {
		t.Fatalf("应当换了第二个账号，实际投递 %d 次", h.prov.n)
	}
}

// 没有可用账号（一个都没配）：依旧是 ErrNoProvider，而不是崩。
func TestNoAccounts(t *testing.T) {
	h := newHarness(t)
	if err := h.r.Send(h.ctx, msg()); !errors.Is(err, ErrNoProvider) {
		t.Fatalf("想要 ErrNoProvider，实际 %v", err)
	}
}

// 停用的账号不参与轮换。
func TestDisabledAccountIsSkipped(t *testing.T) {
	h := newHarness(t)
	id := h.newAccount("off", "log", 10, 5, tzUTC)
	if _, err := h.pool.Exec(h.ctx, "UPDATE mail_accounts SET enabled = false WHERE id = $1", id); err != nil {
		t.Fatal(err)
	}
	if err := h.r.Send(h.ctx, msg()); !errors.Is(err, ErrNoProvider) {
		t.Fatalf("停用的账号不该被用，实际 %v", err)
	}
}

// 凭据解不开（换过主密钥但没配 KeyEnvOld）→ 跳过该账号，而不是整个进程失败。
func TestUndecryptableAccountIsSkipped(t *testing.T) {
	h := newHarness(t)
	h.newAccount("broken", "log", 10, 5, tzUTC)
	other, err := NewCrypter("ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100")
	if err != nil {
		t.Fatal(err)
	}
	h.r.crypt = other
	if err := h.r.Send(h.ctx, msg()); !errors.Is(err, ErrNoProvider) {
		t.Fatalf("解不开凭据的账号必须被跳过，实际 %v", err)
	}
}

// 收件人为空是代码 bug，必须永久失败，不能白占一次额度。
func TestEmptyRecipientIsPermanent(t *testing.T) {
	h := newHarness(t)
	id := h.newAccount("a", "log", 1, 5, tzUTC)
	if err := h.r.Send(h.ctx, Message{Subject: "x"}); !errors.Is(err, ErrPermanent) {
		t.Fatalf("想要 ErrPermanent，实际 %v", err)
	}
	if n := h.quotaCount(id, "2026-10-13"); n != 0 {
		t.Fatalf("根本不该占额度，实际 %d", n)
	}
}

// NextReset：账号时区下一个自然日的 00:30（UTC 表示）。
func TestNextReset(t *testing.T) {
	h := newHarness(t)
	id := h.newAccount("a", "log", 1, 5, tzSH)
	a, err := h.r.accounts(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 1 || a[0].ID != id {
		t.Fatalf("账号列表不对: %+v", a)
	}
	got := h.r.NextReset(a[0])
	// UTC 2026-10-13 12:00 = 上海 20:00 → 下一个上海 00:30 是 UTC 2026-10-13 16:30。
	want := time.Date(2026, 10, 13, 16, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("NextReset = %v, 想要 %v", got, want)
	}
} // 缺主密钥是**运行期**故障，不是启动失败：Send 必须给出可判定的错误（拍板 §12.2 要 503 的依据）。
func TestMissingKeyIsReportedOnSend(t *testing.T) {
	h := newHarness(t)
	h.newAccount("a", "log", 1, 5, tzUTC)
	r := NewRouter(Dependencies{DB: h.db, Store: h.store, Clock: h.clk, Log: h.r.log})
	if r.cfgErr == nil {
		t.Fatal("没配 FORUM_MAIL__KEY 时构造期就该记下配置错误")
	}
	if err := r.Send(h.ctx, msg()); !errors.Is(err, ErrPermanent) {
		t.Fatalf("想要 ErrPermanent，实际 %v", err)
	}
}
