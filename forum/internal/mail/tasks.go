package mail

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"forum/internal/mail/pgsql"
	pgmail "forum/internal/platform/mail"
	"forum/internal/platform/queue"
)

// HandleMailSend 是 mail:send 的任务处理函数（d6 §6.11）。payload 只有 {"id": <mail_log id>}。
//
// 三条纪律：
//   - **幂等**：status 已经是 sent 就直接返回 nil（队列是至少一次投递）；
//   - **事务里不发信**：占额度与写回是两个短事务，Send 在事务外（拍板 §5.4）；
//   - **可判定的失败**：ErrPermanent → failed + ErrSkipRetry；ErrTemporary → 保持 pending 让队列退避；
//     额度用尽 → 保持 pending 并重排到下一个额度重置点。
func (s *Service) HandleMailSend(ctx context.Context, payload []byte) error {
	var p struct {
		ID int64 `json:"id"`
	}
	// payload 是我们自己写的：解不出就是代码 bug，重试多少次都一样
	if err := json.Unmarshal(payload, &p); err != nil || p.ID <= 0 {
		return queue.ErrSkipRetry
	}

	lg, err := s.pg.LoadLog(ctx, p.ID, s.clk.Now())
	if errors.Is(err, sql.ErrNoRows) {
		return queue.ErrSkipRetry // 行没了（被手工删过）：这条任务没有意义
	}
	if err != nil {
		return err // 库暂时不可用 → 让队列重试
	}
	if lg.Status == statusSent {
		return nil // 幂等：已经发过了
	}
	if !s.enabled(ctx) {
		return s.fail(ctx, lg.ID, "mail.enabled = off", queue.ErrSkipRetry)
	}

	msg, err := s.render(ctx, lg)
	if err != nil {
		// 模板缺字段 / 数据解不出 = 代码 bug：置 failed 且不重试（d6 §6.11）
		return s.fail(ctx, lg.ID, err.Error(), queue.ErrSkipRetry)
	}

	// Store 接口里没有 mail_log id（见 platform/mail.Store），所以 Router 是按「一次投递」构造的：
	// 它只能写回它正在发的这一条 mail_logs。代价是账号列表缓存对它无效（每次投递读一次
	// mail_accounts，几行），换来的是「BindQuota 一定能落到对的那一行」——额度绑定写错记录
	// 是静默的数据损坏，比一次小查询贵得多。
	r := pgmail.NewRouter(pgmail.Dependencies{
		DB: s.db, Crypter: s.Crypter, Store: bindStore{svc: s, logID: lg.ID},
		Clock: s.clk, Log: s.log,
	})

	var opts []pgmail.SendOption
	if day, ok := lg.QuotaDay(); ok && lg.QuotaAccountID != nil && lg.QuotaIsToday {
		// 上次已经占过额度，且还是该账号的今天 → 复用，不再 +1（这就是「一次投递」）
		opts = append(opts, pgmail.WithHeld(pgmail.Hold{AccountID: *lg.QuotaAccountID, Day: day}))
	}

	switch err := r.Send(ctx, msg, opts...); {
	case err == nil:
		return s.markLog(ctx, lg.ID, statusSent, "")
	case errors.Is(err, pgmail.ErrPermanent):
		// 凭据不对 / 收件人被拒：换账号也没用
		return s.fail(ctx, lg.ID, err.Error(), queue.ErrSkipRetry)
	case errors.Is(err, pgmail.ErrNoProvider):
		usable, uerr := s.HasUsable(ctx)
		if uerr != nil {
			return uerr
		}
		if !usable {
			// 一个可用账号都没有 = 配置问题（管理员建号后这次重试就能成功）→ 退避重试，不排到明天
			return s.retryLater(ctx, lg.ID, err.Error(), err)
		}
		// 有可用账号却一个都没挑中，两种可能，别混：
		//   - 这个账号今天的额度满了 → 排到下一个重置点；
		//   - 刚才用的就是它、只是临时失败（Router 会把试过的账号排除掉，于是报 ErrNoProvider）
		//     → 额度没满，退避重试即可（排到明天会把一封验证码邮件压一整天）。
		if lg.QuotaIsToday && lg.QuotaAccountID != nil {
			full, ferr := s.pg.QuotaFull(ctx, *lg.QuotaAccountID, s.clk.Now())
			if ferr != nil {
				return ferr
			}
			if !full {
				return s.retryLater(ctx, lg.ID, err.Error(), err)
			}
		}
		return s.requeueTomorrow(ctx, lg, err.Error())
	default:
		// ErrTemporary（网络 / 5xx）与其它未知错误：保持 pending，交给队列退避
		return s.retryLater(ctx, lg.ID, err.Error(), err)
	}
}

// render 把 mail_logs.payload 渲染成一条可以直接交出去的信。
// 站名现取（改站名后旧邮件也用新名字）；模板与主题由 platform/mail 一处提供。
func (s *Service) render(ctx context.Context, lg pgsql.LogRow) (pgmail.Message, error) {
	var d pgmail.Data
	if len(lg.Payload) > 0 {
		if err := json.Unmarshal(lg.Payload, &d); err != nil {
			return pgmail.Message{}, fmt.Errorf("解析邮件数据: %w", err)
		}
	}
	if d.SiteName == "" {
		d.SiteName = s.siteName(ctx)
	}
	// D37：投递前从缓存查一次自定义模板（缓存未命中才读库，编译产物留内存直到下次 PUT/DELETE）。
	// nil = 库里没有（或手改库造成的编译失败）：回落内置，语义零变化。
	custom, err := s.tpl.Get(ctx, lg.Template)
	if err != nil {
		return pgmail.Message{}, err
	}
	var msg pgmail.Message
	if custom != nil {
		msg, err = custom.Render(d)
	} else {
		msg, err = pgmail.Render(lg.Template, d)
	}
	if err != nil {
		return pgmail.Message{}, err
	}
	msg.To = lg.ToAddress
	return msg, nil
}

// markLog 是三种结果唯一的写入口（一条 SQL：sent 记 sent_at，failed/pending 只记 error）。
func (s *Service) markLog(ctx context.Context, logID int64, status, errMsg string) error {
	return s.pg.MarkLog(ctx, logID, status, errMsg, s.clk.Now())
}

// fail 记 failed 并把 ret 还给队列（ret 为 queue.ErrSkipRetry 时进 dead，不再重试）。
func (s *Service) fail(ctx context.Context, logID int64, msg string, ret error) error {
	if err := s.markLog(ctx, logID, statusFailed, msg); err != nil {
		return err
	}
	return ret
}

// retryLater 保持 pending、记下原因，把错误交回队列退避重试。
func (s *Service) retryLater(ctx context.Context, logID int64, msg string, ret error) error {
	if err := s.markLog(ctx, logID, statusPending, msg); err != nil {
		return err
	}
	return ret
}

// requeueTomorrow：额度用尽 → 保持 pending，把同一条任务重排到下一个额度重置点后返回 nil（d6 §6.11）。
//
// 为什么不靠退避重试：退避上限 1 小时 × 默认 5 次 ≈ 31 小时就进 dead，而额度是**按自然日**重置的，
// 第二天本来就能发。代价写在这里：这条 mail_log 会跨天停在 pending，后台的「今日失败数」不含它。
func (s *Service) requeueTomorrow(ctx context.Context, lg pgsql.LogRow, msg string) error {
	if err := s.markLog(ctx, lg.ID, statusPending, msg); err != nil {
		return err
	}
	return s.q.Enqueue(ctx, queue.Task{
		Type:    queue.TypeMailSend,
		Payload: map[string]int64{"id": lg.ID},
		RunAt:   nextReset(s.clk.Now(), lg.ResetTZ),
	})
}

// bindStore 把 Router 的回调带回**这一条** mail_log（Store 接口里没有 log id）。
type bindStore struct {
	svc   *Service
	logID int64
}

// BindQuota 只在 Router 本次**新占**额度时被调用：把占用写回投递记录，下次重试才认得出。
func (b bindStore) BindQuota(ctx context.Context, accountID int64, day string) error {
	return b.svc.pg.BindQuota(ctx, b.logID, accountID, day, b.svc.clk.Now())
}

// Report 记账号健康（成功写 last_ok_at，失败写 last_error），并在**失败时**把这封信绑到
// 刚刚为它花掉的那个额度上（否则重试会再占一次，见 pgsql.ReportAttempt 的说明）。
// 写失败不冒泡：Router 自己会 Warn 掉（信已经交出去了，健康状态是排障信息）。
func (b bindStore) Report(ctx context.Context, accountID int64, sendErr error) error {
	return b.svc.pg.ReportAttempt(ctx, b.logID, accountID, sendErr, b.svc.clk.Now())
}

// nextReset 是「下一个额度重置点」：该账号 reset_tz 的下一个自然日 00:00 + 宽限 35 分钟（= 00:35）。
//
// 公式与 platform/mail.Router.NextReset 是同一条（那边是 00:30 + 5 分钟）；这里自己算，
// 是因为那个方法要一个**从 Router 内部 load 出来的 Account**（loc 是私有字段），本模块拿不到。
// 两边一致由 tasks_test.go 用同一批 tz 断言。
func nextReset(now time.Time, tz string) time.Time {
	loc, err := loadTZ(tz)
	if err != nil {
		loc = time.UTC
	}
	n := now.In(loc)
	y, m, d := n.Date()
	return time.Date(y, m, d+1, 0, 0, 0, 0, loc).Add(requeueAfterReset).UTC()
}

// loadTZ 解析 IANA 名字；空串按列默认值（Asia/Shanghai）。
func loadTZ(tz string) (*time.Location, error) {
	if tz == "" {
		tz = defaultResetTZ
	}
	return time.LoadLocation(tz)
}
