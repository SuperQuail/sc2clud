// Package pgsql 是 report 的原生 SQL 落点（开发必读 §1 第 8 条）。
//
// 只有两条：一条是「同一目标当前的未处理举报数」（阈值判定与队列里那个计数），
// 一条是处理的 CAS（d6 §2.2：条件 UPDATE 才是并发保证，读行只是给人一个确定的 409）。
//
// 参数处一律显式转型（_P2-修正清单 §7 第 7 类）。
package pgsql

import (
	"context"
	"database/sql"
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

// scanOne 跑一条返回单行的查询（**没有 QueryRowContext**：txDriver 只有 Exec / QueryContext）。
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

const countOpenSQL = `SELECT count(*) FROM reports
 WHERE target_type = $1::text AND target_id = $2::bigint AND state = 'open'`

// CountOpenForTarget 走 idx_reports_target（多态表没有外键，索引是自己建的）。
// 它同时服务两件事：举报的阈值判定，以及队列里那一列 open_reports。
func (q *Queries) CountOpenForTarget(ctx context.Context, targetType string, targetID int64) (int, error) {
	rows, err := q.db.QueryContext(ctx, countOpenSQL, targetType, targetID)
	if err != nil {
		return 0, fmt.Errorf("数未处理举报: %w", err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return 0, fmt.Errorf("数未处理举报: %w", err)
		}
		return 0, fmt.Errorf("数未处理举报: 没有返回行")
	}
	var n int
	if err := rows.Scan(&n); err != nil {
		return 0, fmt.Errorf("数未处理举报: %w", err)
	}
	return n, rows.Err()
}

// NewReport 是新建举报的入参（对外 id 由调用方生成，DDL 不给默认值）。
type NewReport struct {
	PublicID   string
	TargetType string
	TargetID   int64
	Reason     string
	Detail     string
	ReporterID int64
	Now        time.Time
}

// ON CONFLICT 的目标是**部分**唯一索引 uq_reports_once：
// 「同一人对同一目标只留一条未处理」，所以被驳回之后还能再报一次（d6 §7.6）。
const insertReportSQL = `INSERT INTO reports (public_id, target_type, target_id, reason, detail, reporter_id, state, created_at, updated_at)
VALUES ($1::uuid, $2::varchar, $3::bigint, $4::varchar, $5::varchar, $6::bigint, 'open', $7::timestamptz, $7::timestamptz)
ON CONFLICT (reporter_id, target_type, target_id) WHERE state = 'open' DO NOTHING
RETURNING id`

const findOpenReportSQL = `SELECT id FROM reports
 WHERE reporter_id = $1::bigint AND target_type = $2::varchar AND target_id = $3::bigint AND state = 'open'`

// InsertReport 建一条 open 举报；created=false 表示同一人对同一目标已经有一条未处理的（幂等，返回既有那条）。
//
// 为什么用 ON CONFLICT 而不是「先 ent 插入、撞唯一索引再回查」：在 PG 里一条语句失败会把**整个事务**
// 置为 aborted，后面任何查询都返回 25P02 —— 那条路在事务里根本走不通。
func (q *Queries) InsertReport(ctx context.Context, in NewReport) (int64, bool, error) {
	var id int64
	err := q.scanOne(ctx, []any{&id}, insertReportSQL,
		in.PublicID, in.TargetType, in.TargetID, in.Reason, in.Detail, in.ReporterID, in.Now.UTC())
	if err == nil {
		return id, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, fmt.Errorf("建举报: %w", err)
	}
	if err := q.scanOne(ctx, []any{&id}, findOpenReportSQL,
		in.ReporterID, in.TargetType, in.TargetID); err != nil {
		return 0, false, fmt.Errorf("读既有举报: %w", err)
	}
	return id, false, nil
}

const handleCASSQL = `UPDATE reports
   SET state = $2::text,
       handler_id = $3::bigint,
       handle_note = $4::varchar,
       handled_at = $5::timestamptz,
       updated_at = $5::timestamptz
 WHERE public_id = $1::uuid AND state = 'open'`

// HandleCAS 是处理的并发保证：只有仍是 open 的那一行会被改动，RowsAffected = 0 表示
// 别人已经处理过了（→ 409 report.already_handled，且不写第二份审计）。
// ck_reports_handled 要求 handled/dismissed 必须带 handler_id + handled_at，这里一并写。
func (q *Queries) HandleCAS(ctx context.Context, publicID, state string, handlerID int64, note string, now time.Time) (int64, error) {
	res, err := q.db.ExecContext(ctx, handleCASSQL, publicID, state, handlerID, note, now.UTC())
	if err != nil {
		return 0, fmt.Errorf("处理举报: %w", err)
	}
	return res.RowsAffected()
}
