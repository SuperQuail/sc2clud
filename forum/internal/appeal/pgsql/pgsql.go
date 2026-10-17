// Package pgsql 是 appeal 域的原生 SQL 落点（开发必读 §1 第 8 条：原生 SQL 只在各域 pgsql 包与手写迁移里）。
//
// 本域的表只有 appeals 一张（0022_appeals），没有 ent schema：它不是实体图里的一环，
// 只有「写一条 / 读一页 / CAS 一次」三种动作，为它生成一整套 ent 代码换不到任何东西。
//
// 事务：句柄走 context（见 tx.go）。**不在事务里时走池** —— 读路径（队列 / 我的申诉 / 查进展）本来就不需要事务。
package pgsql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"forum/internal/appeal"
)

// executor 是池与事务的公共形状（pgxpool.Pool 与 pgx.Tx 都直接满足它）。
type executor interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Store struct {
	pool *pgxpool.Pool
	// current 是当前请求绑上的事务执行器（Service.withTx 设、defer 清）。
	// 它是**每请求实例**的前提：app 层为每个请求 new 一个 Store（见 app/appeal.go 的说明）。
	current executor
}

// New 是构造点：两种用法 ——
//   - 只读场景（e2e 里直接查库、CLI）：New(pool)；
//   - HTTP 请求：New(pool)，配 appeal.WithTx 就会自动切到事务（见 SetTx）。
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// SetTx 绑上事务执行器；传 nil 表示回到池。service 的 withTx 是唯一调用处。
func (s *Store) SetTx(tx appeal.TxHandle) {
	if tx == nil {
		s.current = nil
		return
	}
	if e, ok := tx.Executor().(executor); ok {
		s.current = e
	}
}

// ClearTx 回到池（withTx 的 defer）。它必须存在而不是靠 SetTx(nil)：调用处写错一个参数
// 就会让后面的请求不知不觉跑进一个已经提交的事务里。
func (s *Store) ClearTx() { s.current = nil }

// db 返回这次调用该用哪个执行器：在事务里用事务，否则用池。
func (s *Store) db(ctx context.Context) executor {
	if s.current != nil {
		return s.current
	}
	return s.pool
}

// ---- 语句 ----

// no 是生成列，不能显式插，所以列清单里没有它；RETURNING 把它取回来。
const insertSQL = `INSERT INTO appeals
  (public_id, type, username, email, user_id, identity_verified, topic_id, ref, title, details, contact, created_at, updated_at)
VALUES ($1::uuid, $2::text, $3::varchar, $4::varchar, $5::bigint, $6::boolean, $7::bigint,
        $8::varchar, $9::varchar, $10::text, $11::varchar, $12::timestamptz, $12::timestamptz)
RETURNING id, no`

// insertNoTopicSQL 是同一句去掉 topic_id：$7 传 NULL 时 PG 定不出类型（DescribeExec 报 42P18），
// 所以两种形状各写一句，而不是靠传 nil 赌一把。
const insertNoTopicSQL = `INSERT INTO appeals
  (public_id, type, username, email, user_id, identity_verified, topic_id, ref, title, details, contact, created_at, updated_at)
VALUES ($1::uuid, $2::text, $3::varchar, $4::varchar, $5::bigint, $6::boolean, NULL,
        $7::varchar, $8::varchar, $9::text, $10::varchar, $11::timestamptz, $11::timestamptz)
RETURNING id, no`

// rowColumns 是读视图的列清单（处理人由 LEFT JOIN 带出来；没有处理人时两列都是 NULL）。
const rowColumns = `a.id, a.no, a.type, a.username, a.email, a.user_id, a.identity_verified, a.topic_id, t.public_id,
       a.ref, a.title, a.details, a.contact, a.status, a.decision, a.response, a.handle_note,
       u.username, u.nickname, a.handled_at, a.created_at, a.updated_at`

// 两个 LEFT JOIN 都是**展示用**：处理人给人看，主题对外 id 给前端做链接。
// 主题被删时 public_id 是 NULL（topic_id 已经被 SET NULL，两列会一起空）。
const rowFrom = ` FROM appeals a
  LEFT JOIN users u ON u.id = a.handled_by
  LEFT JOIN topics t ON t.id = a.topic_id`

func scanRow(rows pgx.Rows) (appeal.Row, error) {
	var r appeal.Row
	err := rows.Scan(&r.ID, &r.No, &r.Type, &r.Username, &r.Email, &r.UserID, &r.IdentityVerified, &r.TopicID,
		&r.TopicPublicID, &r.Ref, &r.Title, &r.Details, &r.Contact, &r.Status, &r.Decision, &r.Response,
		&r.HandleNote, &r.HandlerHandle, &r.HandlerNickname, &r.HandledAt, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

// ---- 写 ----

// Insert 建一条申诉，返回内部 id 与对外单号。
func (s *Store) Insert(ctx context.Context, in appeal.NewAppeal) (int64, string, error) {
	var (
		id int64
		no string
	)
	if in.TopicID != nil {
		err := s.db(ctx).QueryRow(ctx, insertSQL, in.PublicID, in.Type, in.Username, in.Email,
			in.UserID, in.IdentityVerified, *in.TopicID, in.Ref, in.Title, in.Details, in.Contact, in.Now.UTC()).
			Scan(&id, &no)
		return id, no, wrap(err, "建申诉")
	}
	err := s.db(ctx).QueryRow(ctx, insertNoTopicSQL, in.PublicID, in.Type, in.Username, in.Email,
		in.UserID, in.IdentityVerified, in.Ref, in.Title, in.Details, in.Contact, in.Now.UTC()).
		Scan(&id, &no)
	return id, no, wrap(err, "建申诉")
}

const findPendingByTopicSQL = `SELECT id, no FROM appeals
 WHERE topic_id = $1::bigint AND status = 'pending'`

// PendingByTopic 是 C5 的幂等回查（拍板 §10.10-1：同一篇帖子只留一条未处理的申诉）。
// 没有时返回 sql.ErrNoRows（wrap 已经把它归一了），由 service 翻成本域的语义。
func (s *Store) PendingByTopic(ctx context.Context, topicID int64) (int64, string, error) {
	var (
		id int64
		no string
	)
	err := s.db(ctx).QueryRow(ctx, findPendingByTopicSQL, topicID).Scan(&id, &no)
	return id, no, wrap(err, "读既有申诉")
}

const refSQL = `SELECT id, user_id FROM appeals WHERE no = $1::varchar AND lower(email) = lower($2::varchar)`

// Ref 是免登录查进展的解 id：**单号与邮箱必须同时命中**（走 0022 的 idx_appeals_no）。
// 任一不命中都返回 sql.ErrNoRows —— 区分「单号不存在」与「邮箱不对」等于给枚举单号的人一个预言机。
func (s *Store) Ref(ctx context.Context, no, email string) (int64, *int64, error) {
	var (
		id     int64
		userID *int64
	)
	err := s.db(ctx).QueryRow(ctx, refSQL, no, email).Scan(&id, &userID)
	return id, userID, wrap(err, "按单号读申诉")
}

const countRecentSQL = `SELECT count(*) FROM appeals
 WHERE type = $1::text AND created_at > $2::timestamptz
   AND ( ($3::bigint IS NOT NULL AND user_id = $3::bigint)
         OR ($4::varchar <> '' AND lower(email) = lower($4::varchar)) )`

// CountRecent 数「同一身份 24 小时内已提交了几条**同类型**申诉」（口径见 types.go 的 maxPerDay）。
//
// 为什么按 (user_id 或 email) 而不是单看 IP：IP 是共享的（学校 / 公司 / 手机网络），
// 拿它当额度会把一整个网段的人绑在一起；邮箱是这条链路自证用的凭据，也是这里唯一稳定的身份。
// **未登录、且邮箱没对上任何账号的人同样在额度内** —— 否则换个瞎编的邮箱就能绕过。
func (s *Store) CountRecent(ctx context.Context, userID int64, email, appealType string, since time.Time) (int, error) {
	var uid *int64
	if userID > 0 {
		uid = &userID
	}
	var n int
	err := s.db(ctx).QueryRow(ctx, countRecentSQL, appealType, since.UTC(), uid, email).Scan(&n)
	return n, wrap(err, "数近期申诉")
}

const decideCASSQL = `UPDATE appeals
   SET status = $2::text, decision = $3::text, response = $4::text, handle_note = $5::varchar,
       handled_by = $6::bigint, handled_at = $7::timestamptz, updated_at = $7::timestamptz
 WHERE no = $1::varchar AND status = 'pending'`

// DecideCAS 是处理的并发保证：只有仍是 pending 的那一行会被改动，RowsAffected = 0 表示
// 别人已经处理过了（→ 409 appeal.already_handled，且不写第二份审计）。
// ck_appeals_handled 要求非 pending 必须带 handled_by + handled_at + 非空 response，这里一并写。
func (s *Store) DecideCAS(ctx context.Context, in appeal.DecideRow) (int64, error) {
	tag, err := s.db(ctx).Exec(ctx, decideCASSQL, in.No, in.Status, in.Decision, in.Response,
		in.Note, in.Handler, in.Now.UTC())
	if err != nil {
		return 0, wrap(err, "处理申诉")
	}
	return tag.RowsAffected(), nil
}

// ---- 读 ----

const getByNoSQL = `SELECT ` + rowColumns + ` ` + rowFrom + ` WHERE a.no = $1::varchar`

// GetByNo 按对外单号读一行（处理完的回执与免登录查进展都用它）。
func (s *Store) GetByNo(ctx context.Context, no string) (*appeal.Row, error) {
	rows, err := s.db(ctx).Query(ctx, getByNoSQL, no)
	if err != nil {
		return nil, wrap(err, "读申诉")
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, wrap(err, "读申诉")
		}
		return nil, sql.ErrNoRows
	}
	r, err := scanRow(rows)
	if err != nil {
		return nil, wrap(err, "读申诉")
	}
	return &r, nil
}

const noByIDSQL = `SELECT no FROM appeals WHERE id = $1::bigint`

// NoByID 在事务里取刚插入那条的单号（幂等回查那条路要用它）。
func (s *Store) NoByID(ctx context.Context, id int64) (string, error) {
	var no string
	err := s.db(ctx).QueryRow(ctx, noByIDSQL, id).Scan(&no)
	return no, wrap(err, "读申诉单号")
}

const listSelect = `SELECT ` + rowColumns + ` ` + rowFrom + ``

// List 是「我的申诉」与「管理端队列」共用的分页查询：created_at DESC, id DESC 游标（多取一条判到底）。
// 拼进 SQL 的只有 $n 占位符，值一律走参数（用户输入的 q 只作为参数值出现）。
func (s *Store) List(ctx context.Context, f appeal.ListFilter) ([]appeal.Row, error) {
	var (
		where []string
		args  []any
	)
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	if f.UserID > 0 {
		add("a.user_id = $%d::bigint", f.UserID)
	}
	if f.Status != "" {
		add("a.status = $%d::text", f.Status)
	}
	if f.Type != "" {
		add("a.type = $%d::text", f.Type)
	}
	if f.Q != "" {
		args = append(args, "%"+strings.ToLower(f.Q)+"%")
		i := len(args)
		where = append(where, fmt.Sprintf(
			"(lower(a.no) LIKE $%d OR lower(a.username) LIKE $%d OR lower(a.email) LIKE $%d OR lower(a.title) LIKE $%d)",
			i, i, i, i))
	}
	if !f.CursorAt.IsZero() {
		args = append(args, f.CursorAt.UTC(), f.CursorID)
		i := len(args)
		where = append(where, fmt.Sprintf("(a.created_at, a.id) < ($%d::timestamptz, $%d::bigint)", i-1, i))
	}
	q := listSelect
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	args = append(args, f.Limit)
	q += fmt.Sprintf(" ORDER BY a.created_at DESC, a.id DESC LIMIT $%d::int", len(args))

	rows, err := s.db(ctx).Query(ctx, q, args...)
	if err != nil {
		return nil, wrap(err, "读申诉列表")
	}
	defer rows.Close()
	out := make([]appeal.Row, 0, f.Limit)
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, wrap(err, "读申诉列表")
		}
		out = append(out, r)
	}
	return out, wrap(rows.Err(), "读申诉列表")
}

// wrap 归一「没有这一行」，其余包一层说明。
// pgx.ErrNoRows 与 sql.ErrNoRows 都被 service 当作「没找到」（pgx 的 stdlib 路径下两者会互换）。
func wrap(err error, what string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, pgx.ErrNoRows) {
		return sql.ErrNoRows
	}
	return fmt.Errorf("appeal: %s: %w", what, err)
}
