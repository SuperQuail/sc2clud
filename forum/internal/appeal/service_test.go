package appeal

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"testing"
	"time"

	"forum/internal/platform/captcha"
	"forum/internal/platform/clock"
)

// 本域的单测：**不连库**。
//
// 为什么要它（e2e 已经覆盖了整条链路）：e2e 起的是嵌入式 PostgreSQL（12 秒起步），
// 而这里三条是纯逻辑 —— 「一道题只有一次机会」「24 小时额度」「review_reject 免登录时被拒」。
// 它们在 e2e 里要么跑不到（额度要 4 次提交），要么代价不成比例。
//
// 存储层用内存替身：本域与库的边界只有一个 Store 接口（见 deps.go），替身就是那条边界的证明。
func TestCreateGuards(t *testing.T) {
	clk := &clock.Fake{T: time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)}
	st := newMemStore()
	cstub := &fakeCaptcha{}
	svc := NewService(st, memTx{}, nil, nil, nil, nil, nil, nil, cstub, clk,
		slog.New(slog.NewTextHandler(discard{}, nil)))

	base := CreateInput{
		Type: TypeOther, Username: "alice", Email: "alice@example.com",
		Title: "标题", Details: "正文",
	}

	// ① 没带验证码：400 的那一族（auth.captcha_required）。**不许静默放行**。
	if _, err := svc.Create(context.Background(), nil, base); !errors.Is(err, ErrCaptchaRequired) {
		t.Fatalf("没带验证码应当 ErrCaptchaRequired，实际 %v", err)
	}
	// ② 答错：auth.captcha_wrong（与「这道题不存在」同一个码，见 errors.go）。
	in := base
	in.CaptchaID, in.CaptchaAnswer = "q1", "WRONG"
	if _, err := svc.Create(context.Background(), nil, in); !errors.Is(err, ErrCaptchaWrong) {
		t.Fatalf("答错应当 ErrCaptchaWrong，实际 %v", err)
	}
	// ③ 一道题只有一次机会：同一道题第二遍必须失败（真出题器的约定，替身照抄）。
	// 换一道新题（替身只认 id=q + ABCD）：答对之后同一道题立刻作废。
	ok := base
	ok.CaptchaID, ok.CaptchaAnswer = cstub.newQuestion()
	if _, err := svc.Create(context.Background(), nil, ok); err != nil {
		t.Fatalf("第一次应当成功，实际 %v", err)
	}
	if _, err := svc.Create(context.Background(), nil, ok); !errors.Is(err, ErrCaptchaWrong) {
		t.Fatalf("同一道题第二遍应当 ErrCaptchaWrong（一次性），实际 %v", err)
	}

	// ④ 24 小时额度：3 条之后第 4 条 429 appeal.rate_limited（文案里的数就是这个）。
	for i := 0; i < maxPerDay-1; i++ {
		n := base
		n.CaptchaID, n.CaptchaAnswer = cstub.newQuestion()
		if _, err := svc.Create(context.Background(), nil, n); err != nil {
			t.Fatalf("第 %d 条应当成功，实际 %v", i+2, err)
		}
	}
	n := base
	n.CaptchaID, n.CaptchaAnswer = cstub.newQuestion()
	if _, err := svc.Create(context.Background(), nil, n); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("第 %d 条应当被额度挡住（ErrRateLimited），实际 %v", maxPerDay+1, err)
	}
	// ⑤ 额度按「同 type + 同身份」数（0022 的注释与 Store.CountRecent 的 SQL 都是这个口径）：
	// 换一种事由是**另一种事由的额度**，所以这条能过。
	// 这是刻意的：一次封禁事件里同一个人常常既要申诉封禁、又要反馈别的；
	// 而滥用那道闸门是验证码 + 每类 3 条的组合，不靠把四类挤进一个额度。
	other := base
	other.Type = TypeBan
	other.CaptchaID, other.CaptchaAnswer = cstub.newQuestion()
	if _, err := svc.Create(context.Background(), nil, other); err != nil {
		t.Fatalf("换一种事由是另一类额度，应当能提交，实际 %v", err)
	}
	// ⑥ 免登录提交 review_reject（C5 的事由）：明确拒绝，不是收下一条没人认领的申诉。
	rr := base
	rr.Type = TypeReviewReject
	rr.CaptchaID, rr.CaptchaAnswer = cstub.newQuestion()
	if _, err := svc.Create(context.Background(), nil, rr); err == nil || !strings.Contains(err.Error(), "invalid_input") {
		t.Fatalf("免登录提交 review_reject 应当 400 invalid_input，实际 %v", err)
	}
	// ⑦ 回执里有单号与时限（设计稿的 done.eta；前端拿它渲染「预计 N 答复」）。
	res := base
	res.CaptchaID, res.CaptchaAnswer = cstub.newQuestion()
	res.Username, res.Email = "bob", "bob@example.com"
	out, err := svc.Create(context.Background(), nil, res)
	if err != nil {
		t.Fatalf("换一个身份应当还能提交，实际 %v", err)
	}
	if out.No == "" || out.Eta == "" || out.Status != StatusPending {
		t.Fatalf("回执缺字段: %+v", out)
	}
}

// ---- 替身 ----

// fakeCaptcha 与 platform/captcha 的语义一致：**答对才算，且一道题只有一次机会**。
// 题目本身是「造出来的」：q1、q2…（每个 id 只能用一次），答案统一 ABCD。
//
// **不能固定一个 id**：真出题器每道题一个新 id，而「一道题只有一次机会」正是本文件要测的
// 性质之一 —— 固定 id 会让 ④ 那一圈额度测试连第二条都提交不上去（第一次已经把它用掉了）。
type fakeCaptcha struct {
	used map[string]bool
	seq  int
}

func (c *fakeCaptcha) Verify(_ context.Context, id, answer string) error {
	if c.used == nil {
		c.used = map[string]bool{}
	}
	if !strings.HasPrefix(id, "q") || answer != "ABCD" || c.used[id] {
		return captcha.ErrWrong
	}
	c.used[id] = true
	return nil
}

// newQuestion 造一道没用过的题（id 只增不减，与真出题器的不可枚举性无关 —— 那是它的用例）。
func (c *fakeCaptcha) newQuestion() (string, string) {
	c.seq++
	return "q" + strconv.Itoa(c.seq+1), "ABCD"
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// memTx 是 TxRunner 的替身：本文件不关心事务语义（那条边界的证明在 e2e），
// 但 withTx 一定要拿得到一个句柄 —— 传 nil 会在第一次提交时 panic。
type memTx struct{}

func (memTx) Begin(context.Context) (TxHandle, error) { return memTxHandle{}, nil }

type memTxHandle struct{}

func (memTxHandle) Commit(context.Context) error   { return nil }
func (memTxHandle) Rollback(context.Context) error { return nil }
func (memTxHandle) Executor() any                  { return nil }

// memStore 是 Store 的内存替身：只实现 Create 那条路用到的三个方法。
// 其余方法返回「没实现」—— 它们属于 e2e 覆盖的范围（列表 / 查进展 / 处理）。
type memStore struct {
	rows []NewAppeal
	seq  int
}

func newMemStore() *memStore { return &memStore{} }

func (s *memStore) SetTx(TxHandle) {}
func (s *memStore) ClearTx()       {}

func (s *memStore) Insert(_ context.Context, in NewAppeal) (int64, string, error) {
	s.seq++
	s.rows = append(s.rows, in)
	return int64(s.seq), "AP-2001", nil
}

func (s *memStore) CountRecent(_ context.Context, userID int64, email, appealType string, since time.Time) (int, error) {
	n := 0
	for _, r := range s.rows {
		if r.Type != appealType || r.Now.Before(since) {
			continue
		}
		if (userID > 0 && r.UserID != nil && *r.UserID == userID) || strings.EqualFold(r.Email, email) {
			n++
		}
	}
	return n, nil
}

func (s *memStore) PendingByTopic(context.Context, int64) (int64, string, error) {
	return 0, "", sql.ErrNoRows
}
func (s *memStore) Ref(context.Context, string, string) (int64, *int64, error) {
	return 0, nil, sql.ErrNoRows
}
func (s *memStore) List(context.Context, ListFilter) ([]Row, error) { return nil, nil }
func (s *memStore) GetByNo(context.Context, string) (*Row, error) {
	return nil, sql.ErrNoRows
}
func (s *memStore) NoByID(context.Context, int64) (string, error) { return "", sql.ErrNoRows }
func (s *memStore) DecideCAS(context.Context, DecideRow) (int64, error) {
	return 0, nil
}
