// Package pgsql 是 mail 的原生 SQL 落点（开发必读 §1 第 8 条）。
//
// 为什么这几条不是 ent：
//   - InsertLog 要 **ON CONFLICT (idempotency_key) DO NOTHING RETURNING id**（幂等键的支点）；
//   - LoadLog 要 LEFT JOIN mail_accounts 拿到 reset_tz，并在 SQL 里算「quota_day 是不是该账号的今天」
//     —— 这个判定必须与 Router 占额度时的表达式逐字一致；
//   - MarkLog 一条语句覆盖 sent / failed / pending 三种落点；
//   - SentToday 的「今天」是**每个账号自己的**自然日（reset_tz 不同则日期不同），要 LEFT JOIN 里算。
//
// 参数处一律显式转型（_P2-修正清单 §7 第 7 类：PG 会把未定型的参数推断成 text/interval）。
package pgsql

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	ent "forum/internal/ent"
)

type execQuery interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

type Queries struct{ db execQuery }

func New(db *ent.Client) *Queries { return &Queries{db: db} }

func NewTx(tx *ent.Tx) *Queries { return &Queries{db: tx} }

func (q *Queries) scanOne(ctx context.Context, dest []any, query string, args ...any) error {
	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return err
		}
		return sql.ErrNoRows
	}
	return rows.Scan(dest...)
}

// ---- 账号 ----

// Candidate 是「可能可用」的账号（HasUsable 用它逐个试解密）。
type Candidate struct {
	ID       int64
	PublicID string
	Cipher   []byte
	Nonce    []byte
	ResetTZ  string
}

const candidatesSQL = `SELECT id, public_id::text, secret_cipher, secret_nonce, reset_tz
  FROM mail_accounts
 WHERE enabled AND archived_at IS NULL AND secret_cipher IS NOT NULL
 ORDER BY priority DESC, id`

// Candidates 与 platform/mail.Router 的取账号过滤条件逐字一致（enabled + 未归档 + 有凭据）。
// 解不开凭据、reset_tz 非法的账号由调用方跳过 —— 那是解密与 tz 的事，SQL 里看不见。
func (q *Queries) Candidates(ctx context.Context) ([]Candidate, error) {
	rows, err := q.db.QueryContext(ctx, candidatesSQL)
	if err != nil {
		return nil, fmt.Errorf("读可用发信账号: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.ID, &c.PublicID, &c.Cipher, &c.Nonce, &c.ResetTZ); err != nil {
			return nil, fmt.Errorf("读可用发信账号: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

const sentTodaySQL = `SELECT a.id, COALESCE(q.count, 0)
  FROM mail_accounts a
  LEFT JOIN mail_quota q
    ON q.account_id = a.id AND q.day = ($1::timestamptz AT TIME ZONE a.reset_tz)::date
 WHERE a.id = ANY($2::bigint[])`

// SentToday 读每个账号「今天」已经发了几封（今天是各账号 reset_tz 的自然日）。
func (q *Queries) SentToday(ctx context.Context, ids []int64, now time.Time) (map[int64]int, error) {
	out := make(map[int64]int, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.db.QueryContext(ctx, sentTodaySQL, now.UTC(), ids)
	if err != nil {
		return nil, fmt.Errorf("读今日发信量: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("读今日发信量: %w", err)
		}
		out[id] = n
	}
	return out, rows.Err()
}

const quotaFullSQL = `SELECT COALESCE(q.count, 0) >= a.daily_limit
  FROM mail_accounts a
  LEFT JOIN mail_quota q
    ON q.account_id = a.id AND q.day = ($1::timestamptz AT TIME ZONE a.reset_tz)::date
 WHERE a.id = $2::bigint`

// QuotaFull 回答「这个账号今天的额度是不是已经满了」。
// 它只在 ErrNoProvider 这条罕见路径上用：区分「额度真的用尽（排到明天）」与
// 「刚试过的账号临时失败、又被 Router 排除掉了（退避重试）」。
func (q *Queries) QuotaFull(ctx context.Context, accountID int64, now time.Time) (bool, error) {
	var full bool
	if err := q.scanOne(ctx, []any{&full}, quotaFullSQL, now.UTC(), accountID); err != nil {
		return false, fmt.Errorf("读账号额度是否用尽: %w", err)
	}
	return full, nil
}

const referencedByLogsSQL = `SELECT EXISTS (SELECT 1 FROM mail_logs WHERE quota_account_id = $1::bigint)`

// ReferencedByLogs：删账号时用它决定「硬删」还是「归档」。
func (q *Queries) ReferencedByLogs(ctx context.Context, accountID int64) (bool, error) {
	var exists bool
	if err := q.scanOne(ctx, []any{&exists}, referencedByLogsSQL, accountID); err != nil {
		return false, fmt.Errorf("查账号是否被投递记录引用: %w", err)
	}
	return exists, nil
}

const quotaDaySQL = `SELECT ($1::timestamptz AT TIME ZONE $2::text)::date::text`

// QuotaDay 读「该时区的今天」，与 Router 占额度时的表达式逐字一致（$2 AT TIME ZONE reset_tz）。
func (q *Queries) QuotaDay(ctx context.Context, now time.Time, tz string) (string, error) {
	var day string
	if err := q.scanOne(ctx, []any{&day}, quotaDaySQL, now.UTC(), tz); err != nil {
		return "", fmt.Errorf("算额度日: %w", err)
	}
	return day, nil
}

const reportOKSQL = `UPDATE mail_accounts
   SET last_ok_at = $2::timestamptz, last_error = NULL, last_error_at = NULL
 WHERE id = $1::bigint`

const reportErrSQL = `UPDATE mail_accounts
   SET last_error = $2::text, last_error_at = $3::timestamptz
 WHERE id = $1::bigint`

const bindFailedAttemptSQL = `UPDATE mail_logs l
   SET quota_account_id = a.id,
       quota_day = (($3::timestamptz AT TIME ZONE a.reset_tz)::date),
       updated_at = $3::timestamptz
  FROM mail_accounts a
 WHERE l.id = $2::bigint AND a.id = $1::bigint`

// ReportAttempt 是 platform/mail.Store.Report 的落点，做两件事：
//
//  1. 记账号健康（错误串截到 2000 字：SMTP 的报错可以很长，而这一列是给人看的排障信息）；
//  2. **投递失败时把这封信绑到刚刚为它花掉的那个额度上**。平台的 BindQuota 只在发送成功时被调用，
//     而失败的那次尝试同样已经把额度 +1 了（Router 是先占额度再发）—— 不绑的话重试会再花一次，
//     「一次投递占一次额度」就在失败路径上破了。绑定之后重试走 reuse 分支，不再 +1。
func (q *Queries) ReportAttempt(ctx context.Context, logID, accountID int64, sendErr error, now time.Time) error {
	if sendErr == nil {
		if _, err := q.db.ExecContext(ctx, reportOKSQL, accountID, now.UTC()); err != nil {
			return fmt.Errorf("记账号健康状态: %w", err)
		}
		return nil
	}
	msg := sendErr.Error()
	if len(msg) > 2000 {
		msg = msg[:2000]
	}
	if _, err := q.db.ExecContext(ctx, reportErrSQL, accountID, msg, now.UTC()); err != nil {
		return fmt.Errorf("记账号失败原因: %w", err)
	}
	if _, err := q.db.ExecContext(ctx, bindFailedAttemptSQL, accountID, logID, now.UTC()); err != nil {
		return fmt.Errorf("写回失败尝试占用的额度: %w", err)
	}
	return nil
}

// ---- 投递记录 ----

// NewLog 是新建投递记录的入参。
type NewLog struct {
	IdempotencyKey string
	ToAddress      string
	Template       string
	Payload        json.RawMessage
	Now            time.Time
}

const insertLogSQL = `INSERT INTO mail_logs (idempotency_key, to_address, template, payload, status, created_at, updated_at)
VALUES ($1::varchar, $2::varchar, $3::varchar, $4::jsonb, 'pending', $5::timestamptz, $5::timestamptz)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id`

const findLogByKeySQL = `SELECT id FROM mail_logs WHERE idempotency_key = $1::varchar`

// InsertLog 建一条 pending 记录；created=false 表示幂等键撞了（返回既有那条的 id）。
func (q *Queries) InsertLog(ctx context.Context, in NewLog) (int64, bool, error) {
	var id int64
	err := q.scanOne(ctx, []any{&id}, insertLogSQL,
		in.IdempotencyKey, in.ToAddress, in.Template, string(in.Payload), in.Now.UTC())
	if err == nil {
		return id, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, fmt.Errorf("建投递记录: %w", err)
	}
	if err := q.scanOne(ctx, []any{&id}, findLogByKeySQL, in.IdempotencyKey); err != nil {
		return 0, false, fmt.Errorf("读既有投递记录: %w", err)
	}
	return id, false, nil
}

// LogRow 是 mail:send 处理函数要看的那几列（d6 §7.4 的查询）。
type LogRow struct {
	ID           int64
	Status       string
	Attempts     int
	Template     string
	Payload      json.RawMessage
	ToAddress    string
	ResetTZ      string // 绑定账号的时区；没绑定时是空串（调用方按默认值兜）
	QuotaIsToday bool   // quota_day 是否仍是该账号的今天（跨过午夜就不算）

	QuotaAccountID *int64
	QuotaDayText   string // "2006-01-02"；没绑定是空串
}

const loadLogSQL = `SELECT l.id, l.status, l.attempts, l.template, l.payload::text, l.to_address,
       l.quota_account_id, COALESCE(l.quota_day::text, ''), COALESCE(a.reset_tz, ''),
       COALESCE(l.quota_day = ($1::timestamptz AT TIME ZONE a.reset_tz)::date, false)
  FROM mail_logs l
  LEFT JOIN mail_accounts a ON a.id = l.quota_account_id
 WHERE l.id = $2::bigint`

// LoadLog 读一条投递记录（读不到返回 sql.ErrNoRows）。
func (q *Queries) LoadLog(ctx context.Context, logID int64, now time.Time) (LogRow, error) {
	var (
		lg      LogRow
		payload string
	)
	err := q.scanOne(ctx, []any{
		&lg.ID, &lg.Status, &lg.Attempts, &lg.Template, &payload, &lg.ToAddress,
		&lg.QuotaAccountID, &lg.QuotaDayText, &lg.ResetTZ, &lg.QuotaIsToday,
	}, loadLogSQL, now.UTC(), logID)
	if err != nil {
		return LogRow{}, err
	}
	lg.Payload = json.RawMessage(payload)
	return lg, nil
}

// QuotaDay 把 "2006-01-02" 变成 Hold 要的 time.Time（UTC 零点，与 date 的语义一致）。
func (lg LogRow) QuotaDay() (time.Time, bool) {
	if lg.QuotaDayText == "" {
		return time.Time{}, false
	}
	d, err := time.Parse("2006-01-02", lg.QuotaDayText)
	if err != nil {
		return time.Time{}, false
	}
	return d, true
}

const markLogSQL = `UPDATE mail_logs l
   SET status = $2::text,
       error = NULLIF($3::text, ''),
       attempts = l.attempts + 1,
       sent_at = CASE WHEN $2::text = 'sent' THEN $4::timestamptz ELSE l.sent_at END,
       provider = COALESCE((SELECT a.provider FROM mail_accounts a WHERE a.id = l.quota_account_id), l.provider),
       updated_at = $4::timestamptz
 WHERE l.id = $1::bigint`

// MarkLog 是三种落点唯一的写入口：sent 记 sent_at、failed/pending 只记 error（空串 → NULL）。
// attempts 每次都 +1：它是「这条投递尝试了几次」，与额度（一次投递一次）不是一回事。
func (q *Queries) MarkLog(ctx context.Context, logID int64, status, errMsg string, now time.Time) error {
	if _, err := q.db.ExecContext(ctx, markLogSQL, logID, status, errMsg, now.UTC()); err != nil {
		return fmt.Errorf("记投递结果: %w", err)
	}
	return nil
}

const bindQuotaSQL = `UPDATE mail_logs
   SET quota_account_id = $2::bigint, quota_day = $3::date, updated_at = $4::timestamptz
 WHERE id = $1::bigint`

// BindQuota 把「这次投递占的是哪个账号哪一天的额度」写回投递记录（platform/mail.Store.BindQuota）。
// day 是 "2006-01-02"（Router 给的格式），显式转 date；now 由调用方从 clock 取（本层不碰时间源）。
func (q *Queries) BindQuota(ctx context.Context, logID, accountID int64, day string, now time.Time) error {
	if _, err := q.db.ExecContext(ctx, bindQuotaSQL, logID, accountID, day, now.UTC()); err != nil {
		return fmt.Errorf("写回额度绑定: %w", err)
	}
	return nil
}

// ---- 模板（D37：mail_templates）----

// TemplateRow 是 mail_templates 的一行。回落语义在 Service：缺行 = 内置，这里不建行。
type TemplateRow struct {
	Kind      string
	Subject   string
	HTMLBody  string
	TextBody  string
	UpdatedAt time.Time
}

const templateSQL = `SELECT kind, subject, html_body, text_body, updated_at
  FROM mail_templates
 WHERE kind = $1::varchar`

// Template 读一行自定义模板（读不到返回 sql.ErrNoRows —— 回落内置由调用方决定）。
func (q *Queries) Template(ctx context.Context, kind string) (TemplateRow, error) {
	var r TemplateRow
	if err := q.scanOne(ctx, []any{&r.Kind, &r.Subject, &r.HTMLBody, &r.TextBody, &r.UpdatedAt}, templateSQL, kind); err != nil {
		return TemplateRow{}, err
	}
	return r, nil
}

const templatesSQL = `SELECT kind, subject, html_body, text_body, updated_at
  FROM mail_templates
 ORDER BY id`

// Templates 读全部自定义模板（最多四行）。
func (q *Queries) Templates(ctx context.Context) ([]TemplateRow, error) {
	rows, err := q.db.QueryContext(ctx, templatesSQL)
	if err != nil {
		return nil, fmt.Errorf("读邮件模板: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []TemplateRow
	for rows.Next() {
		var r TemplateRow
		if err := rows.Scan(&r.Kind, &r.Subject, &r.HTMLBody, &r.TextBody, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("读邮件模板: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

const upsertTemplateSQL = `INSERT INTO mail_templates (kind, subject, html_body, text_body, updated_at, updated_by)
VALUES ($1::varchar, $2::text, $3::text, $4::text, $5::timestamptz, $6::bigint)
ON CONFLICT (kind) DO UPDATE SET
  subject = $2::text, html_body = $3::text, text_body = $4::text,
  updated_at = $5::timestamptz, updated_by = $6::bigint`

// UpsertTemplate 保存一份自定义模板（PUT 全量三段）。管理员传 0 时 updated_by 走 NULL。
func (q *Queries) UpsertTemplate(ctx context.Context, kind, subject, htmlBody, textBody string, updatedBy int64, now time.Time) error {
	var by any
	if updatedBy > 0 {
		by = updatedBy
	}
	if _, err := q.db.ExecContext(ctx, upsertTemplateSQL, kind, subject, htmlBody, textBody, now.UTC(), by); err != nil {
		return fmt.Errorf("保存邮件模板 %s: %w", kind, err)
	}
	return nil
}

const deleteTemplateSQL = `DELETE FROM mail_templates WHERE kind = $1::varchar`

// DeleteTemplate 恢复内置：下一次渲染落回 embed（缺行 = 内置的同一条语义）。
func (q *Queries) DeleteTemplate(ctx context.Context, kind string) error {
	if _, err := q.db.ExecContext(ctx, deleteTemplateSQL, kind); err != nil {
		return fmt.Errorf("删除邮件模板 %s: %w", kind, err)
	}
	return nil
}
