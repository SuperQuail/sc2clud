package mail

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"forum/internal/platform/clock"
	platformdb "forum/internal/platform/db"

	ent "forum/internal/ent"
)

// execer 是 *ent.Tx 与 *ent.Client 共有的最小执行面（ent 的提升方法，见 _P2-修正清单 §1）。
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// querier 是读多行需要的最小面。**没有 QueryRowContext**：txDriver 只有 Exec / QueryContext。
type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Account 是一个发信账号（凭据已解密）。
//
// Secret 只在这份结构里存活：**禁止写进日志 / 审计 / 响应**（d6 §8.2）。
type Account struct {
	ID          int64
	Name        string
	Provider    string
	Priority    int
	DailyLimit  int
	ResetTZ     string
	FromAddress string
	FromName    string
	Options     json.RawMessage
	Secret      []byte

	loc *time.Location // reset_tz 解析一次，NextReset 用它
}

// Router 按 priority 轮换账号，并把「占额度」与投递绑在一起。
type Router struct {
	db    *ent.Client
	crypt *Crypter
	store Store
	clk   clock.Clock
	log   *slog.Logger
	ttl   time.Duration

	mu     sync.Mutex
	cache  []Account
	loaded time.Time

	// providerFn 是 provider 的构造方式；nil 时用 provider() 的默认实现。
	// 测试靠它注入假 provider（测的是额度与换账号逻辑，不是 HTTP）。
	providerFn func(Account) (Provider, error)

	// cfgErr 是构造期就能发现、但那一刻不该让进程停下配置错误（缺主密钥）。
	// 存在这里、第一次 Send 时报出去：拍板 §12.2 要的是「注册接口 503 auth.mail_unavailable」，
	// 所以「发信能不能用」必须是可判定的一件事，而不是启动时直接崩。
	cfgErr error
}

// NewRouter 组装 Router。CacheTTL = 0 表示不缓存（每次重新读库）。
//
// 凭据主密钥只从环境变量读（KeyEnv / KeyEnvOld，v2 §8.7）；Crypter 为空时在这里建。
// 缺主密钥不改用「明文凭据」之类的降级：那是把故障换成泄漏。
func NewRouter(deps Dependencies) *Router {
	log := deps.Log
	if log == nil {
		log = slog.Default()
	}
	crypt := deps.Crypter
	var cfgErr error
	if crypt == nil {
		crypt, cfgErr = NewCrypter(os.Getenv(KeyEnv), splitKeys(os.Getenv(KeyEnvOld))...)
		if cfgErr != nil {
			cfgErr = fmt.Errorf("mail: %w", cfgErr)
		}
	}
	return &Router{
		db: deps.DB, crypt: crypt, store: deps.Store,
		clk: deps.Clock, log: log, ttl: deps.CacheTTL,
		cfgErr: cfgErr,
	}
}

// splitKeys 把逗号分隔的旧密钥串切开；空串切出空切片（NewCrypter 会跳过空项）。
func splitKeys(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return strings.Split(s, ",")
}

// Invalidate 丢弃账号缓存：后台任何写操作（新建 / 改 / 停用 / 删）之后调用。
func (r *Router) Invalidate() {
	r.mu.Lock()
	r.loaded = time.Time{}
	r.mu.Unlock()
}

// Send 投递一次。额度占用的粒度是**一次投递**，不是一次尝试（v2 §8.3 第 0 步）：
//
//   - 传 WithHeld（投递记录里已有的 quota_account_id / quota_day）时先复用它，**不再 +1**；
//     Router 自己判定这个 Hold 是不是「今天」的（跨了账号午夜就不再是今天，按新占处理）。
//   - 没有 Hold、或 Hold 已失效 → 按 priority 从高到低挑一个账号，条件 upsert 原子占 1 次；
//     占成功才调 Store.BindQuota 写回投递记录，否则下次重试认不出已占。
//   - ErrQuotaExceeded / ErrTemporary 换下一个账号；ErrPermanent 直接放弃（换账号也没用）。
//
// 返回的 error 一定是 Classify 过的三类之一，或 ErrNoProvider。
func (r *Router) Send(ctx context.Context, m Message, opts ...SendOption) error {
	if r.cfgErr != nil {
		return fmt.Errorf("%w: %v", ErrPermanent, r.cfgErr)
	}
	if m.To == "" {
		return fmt.Errorf("%w: 收件人为空", ErrPermanent)
	}
	var o sendOpts
	for _, fn := range opts {
		fn(&o)
	}

	// 先试上次占住的那个账号：命中就不再占额度（这就是「按一次投递算额度」）。
	exclude := map[int64]bool{}
	if o.hold != nil {
		a, _, ok, err := r.reuse(ctx, *o.hold)
		if err != nil {
			return err
		}
		if ok {
			if err := r.send(ctx, a, m); err != nil {
				r.report(ctx, a, err)
				if !errors.Is(err, ErrTemporary) && !errors.Is(err, ErrQuotaExceeded) {
					return err
				}
				// 临时失败 / 额度超限：这封信今天不能再借这个账号了，换一个。
				exclude[a.ID] = true
			} else {
				r.report(ctx, a, nil)
				return nil // 额度上次已写回，这里不需要再写
			}
		}
		// 复用不成立（账号停了 / 跨了账号午夜 / 当天额度已满）时不排除它：
		// 接下来按新占的逻辑重挑，pick 会因为额度满或账号不可用而自然跳过它。
	}
	var lastTemporary error
	for {
		a, h, err := r.pick(ctx, exclude)
		if errors.Is(err, ErrNoProvider) {
			if lastTemporary != nil {
				return lastTemporary // 有账号但都临时失败：让队列退避重试，不排到明天
			}
			return ErrNoProvider
		}
		if err != nil {
			return err
		}

		if err := r.send(ctx, a, m); err != nil {
			r.report(ctx, a, err)
			switch {
			case errors.Is(err, ErrQuotaExceeded):
				exclude[a.ID] = true
				continue
			case errors.Is(err, ErrTemporary):
				lastTemporary = err
				exclude[a.ID] = true
				continue
			default: // ErrPermanent
				return err
			}
		}

		r.report(ctx, a, nil)
		if h.new {
			if err := r.store.BindQuota(ctx, h.id, h.day); err != nil {
				return err
			}
		}
		return nil
	}
}

// reuse 判定「上次占住的额度还算不算数」，算就把账号取回来（不占额度）。
//
// 三个条件缺一不可：账号还在（未停用 / 未归档）、额度日仍是该账号的今天、当天额度没被别的信占满。
// 第三条是安全阀：额度日相同但 count 已经到顶，说明这个账号今天已经发满了，不能再借它发。
func (r *Router) reuse(ctx context.Context, h Hold) (Account, held, bool, error) {
	accts, err := r.accounts(ctx)
	if err != nil {
		return Account{}, held{}, false, err
	}
	for _, a := range accts {
		if a.ID != h.AccountID {
			continue
		}
		today, err := r.quotaDay(ctx, a.ResetTZ)
		if err != nil {
			return Account{}, held{}, false, err
		}
		if today != h.Day.Format("2006-01-02") {
			return Account{}, held{}, false, nil // 跨过了账号午夜：按新占处理
		}
		var n int
		rows, err := r.db.QueryContext(ctx,
			"SELECT count FROM mail_quota WHERE account_id = $1 AND day = $2::date", a.ID, today)
		if err != nil {
			return Account{}, held{}, false, fmt.Errorf("mail: 读额度: %w", err)
		}
		defer func() { _ = rows.Close() }()
		if rows.Next() {
			if err := rows.Scan(&n); err != nil {
				return Account{}, held{}, false, fmt.Errorf("mail: 读额度: %w", err)
			}
		}
		if n >= a.DailyLimit {
			return Account{}, held{}, false, nil
		}
		return a, held{id: a.ID, day: today}, true, nil
	}
	return Account{}, held{}, false, nil // 账号被停用 / 归档 / 删除
}

// send 只负责「把信交给某个账号的 provider」。
func (r *Router) send(ctx context.Context, a Account, m Message) error {
	build := r.providerFn
	if build == nil {
		build = r.provider
	}
	p, err := build(a)
	if err != nil {
		return err
	}
	return Classify(p.Send(ctx, m))
}

// report 记账号健康。写失败不冒泡：信已经交出去了，健康状态是排障信息，
// 让它把一次成功的投递变成失败没有意义（d6 §8.4 那一栏「不要人修」）。
func (r *Router) report(ctx context.Context, a Account, sendErr error) {
	if r.store == nil {
		return
	}
	if err := r.store.Report(ctx, a.ID, sendErr); err != nil {
		r.log.Warn("mail: 记录账号健康状态失败", "account", a.Name, "err", err.Error())
	}
}

var errQuotaFull = errors.New("mail: 该账号今天额度已满")

// pick 选一个账号并占额度；候选为空返回 ErrNoProvider。
func (r *Router) pick(ctx context.Context, exclude map[int64]bool) (Account, held, error) {
	accts, err := r.accounts(ctx)
	if err != nil {
		return Account{}, held{}, err
	}
	var lastErr error
	for _, a := range accts {
		if exclude[a.ID] {
			continue
		}
		h, err := r.acquire(ctx, a)
		if errors.Is(err, errQuotaFull) {
			continue
		}
		if err != nil {
			lastErr = err
			continue
		}
		return a, h, nil
	}
	if lastErr != nil {
		return Account{}, held{}, lastErr
	}
	return Account{}, held{}, ErrNoProvider
}

// sqlAcquire 是条件 upsert（d6 §7.3）。额度满时 RowsAffected = 0，一行都不写。
//
// 参数处全部显式转型（_P2-修正清单 §7 第 7 类：PG 按上下文推断参数类型，
// 不写死时 $2::timestamptz AT TIME ZONE $3 可能把 $3 推成 interval）。
// day 一定在 SQL 里算（$2 AT TIME ZONE reset_tz），不在 Go 侧算日期：
// 「同一天」的判定必须与读回时用同一个表达式，否则重试恰好跨过账号午夜就会误判。
const sqlAcquire = `INSERT INTO mail_quota (account_id, day, count, updated_at)
VALUES ($1::bigint, ($2::timestamptz AT TIME ZONE $3::text)::date, 1, $2::timestamptz)
ON CONFLICT (account_id, day) DO UPDATE
   SET count = mail_quota.count + 1,
       updated_at = $2::timestamptz
 WHERE mail_quota.count < $4::int`

// sqlQuotaDay 读回「今天」的自然日，与 sqlAcquire 里的表达式逐字一致。
const sqlQuotaDay = `SELECT ($1::timestamptz AT TIME ZONE $2::text)::date`

func (r *Router) quotaDay(ctx context.Context, resetTZ string) (string, error) {
	rows, err := r.db.QueryContext(ctx, sqlQuotaDay, r.clk.Now(), resetTZ)
	if err != nil {
		return "", fmt.Errorf("mail: 读额度日: %w", err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", fmt.Errorf("mail: 读额度日: %w", err)
		}
		return "", errors.New("mail: 读额度日: 没有返回行")
	}
	var day time.Time
	if err := rows.Scan(&day); err != nil {
		return "", fmt.Errorf("mail: 读额度日: %w", err)
	}
	return day.Format("2006-01-02"), nil
}

// acquire 原子占一次额度。额度满返回 errQuotaFull。
func (r *Router) acquire(ctx context.Context, a Account) (held, error) {
	var h held
	err := platformdb.WithTx(ctx, r.db, func(tx *ent.Tx) error {
		res, err := tx.ExecContext(ctx, sqlAcquire, a.ID, r.clk.Now(), a.ResetTZ, a.DailyLimit)
		if err != nil {
			return fmt.Errorf("mail: 占额度: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return errQuotaFull
		}
		day, err := r.quotaDay(ctx, a.ResetTZ)
		if err != nil {
			return err
		}
		h = held{id: a.ID, day: day, new: true}
		return nil
	})
	if err != nil {
		return held{}, err
	}
	return h, nil
}

// NextReset 是该账号下一个自然日的 00:30（reset_tz）：额度重置后重排任务用它。
func (r *Router) NextReset(a Account) time.Time {
	loc := a.loc
	if loc == nil {
		loc = time.UTC
	}
	now := r.clk.Now().In(loc)
	y, m, d := now.Date()
	return time.Date(y, m, d+1, 0, 30, 0, 0, loc).UTC()
}

const sqlAccounts = `SELECT id, name, provider, priority, daily_limit, reset_tz, from_address, from_name,
       options_json::text, secret_cipher, secret_nonce, public_id::text
  FROM mail_accounts
 WHERE enabled AND archived_at IS NULL
 ORDER BY priority DESC, id`

// accounts 读账号列表（带进程内缓存）。解不开凭据的账号**跳过**并记 Warn：
// 主密钥换过但没配 KeyEnvOld 时，表现是「邮件积压 pending」而不是「进程起不来」（d6 §8.4）。
func (r *Router) accounts(ctx context.Context) ([]Account, error) {
	r.mu.Lock()
	if r.ttl > 0 && len(r.cache) > 0 && r.clk.Now().Sub(r.loaded) < r.ttl {
		out := r.cache
		r.mu.Unlock()
		return out, nil
	}
	r.mu.Unlock()

	list, err := r.load(ctx)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.cache, r.loaded = list, r.clk.Now()
	r.mu.Unlock()
	return list, nil
}

func (r *Router) load(ctx context.Context) ([]Account, error) {
	rows, err := r.db.QueryContext(ctx, sqlAccounts)
	if err != nil {
		return nil, fmt.Errorf("mail: 读发信账号: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Account
	for rows.Next() {
		var (
			a          Account
			options    string
			ciphertext []byte
			nonce      []byte
			publicID   string
		)
		if err := rows.Scan(&a.ID, &a.Name, &a.Provider, &a.Priority, &a.DailyLimit, &a.ResetTZ,
			&a.FromAddress, &a.FromName, &options, &ciphertext, &nonce, &publicID); err != nil {
			return nil, fmt.Errorf("mail: 读发信账号: %w", err)
		}
		a.Options = json.RawMessage(options)
		if len(ciphertext) == 0 || len(nonce) == 0 {
			r.log.Warn("mail: 账号没有凭据，跳过", "account", a.Name)
			continue
		}
		secret, err := r.crypt.Decrypt(ciphertext, nonce, []byte(publicID))
		if err != nil {
			r.log.Warn("mail: 凭据解不开，跳过（检查 "+KeyEnvOld+"）", "account", a.Name, "err", err.Error())
			continue
		}
		a.Secret = secret
		loc, err := time.LoadLocation(a.ResetTZ)
		if err != nil {
			r.log.Warn("mail: reset_tz 不是合法的 IANA 名字，跳过", "account", a.Name, "tz", a.ResetTZ, "err", err.Error())
			continue
		}
		a.loc = loc
		out = append(out, a)
	}
	return out, rows.Err()
}
