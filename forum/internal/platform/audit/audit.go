// Package audit 是 audit_logs 的写入器。
//
// 写入点清单与 detail 形状见 d6-reward.md §1.1；事务纪律见拍板 §5.4：
// **审计行必须与业务行同一个事务**——否则会出现「核验成功但审计丢失」，而审计是追责的唯一途径。
// 所以 Write / WriteBatch 收 *ent.Tx，不收 *ent.Client。
package audit

import (
	"context"
	"fmt"

	ent "forum/internal/ent"
	"forum/internal/platform/clock"
)

// Entry 是一条审计行。TargetID 是**对外 id**（public_id 或业务 key），绝不写自增 id（拍板 §5.6）。
type Entry struct {
	ActorID    int64          // 0 = NULL（CLI 与系统动作）
	Action     string         // 动作名，如 role.grant / reward.verify
	TargetType string         // user / role / board / permission / mail_account …
	TargetID   string         // public_id 或业务 key
	Detail     map[string]any // 统一 {"before":…,"after":…}
	IP         string         // handler 从 c.ClientIP() 放进 Input（service 不碰 gin）
}

// Writer 是审计的唯一写入器。拿到它的人不需要知道表名与列名。
type Writer struct {
	db  execer
	clk clock.Clock
}

// New 只收 ent 客户端（事务由 Write 传进来）。
func New(db *ent.Client, clk clock.Clock) *Writer {
	return &Writer{db: db, clk: clk}
}

// compile-time guard：execer 由 *ent.Client 与 *ent.Tx 共同满足（ent 的提升方法）。
var (
	_ execer = (*ent.Client)(nil)
	_ execer = (*ent.Tx)(nil)
)

// Write 写一条，与业务同一个事务。tx 为 nil 表示「当前不在事务里」——
// 只有测试夹具与 CLI 走这条路（生产路径的审计按 §1.1 全部与业务同事务）。
func (w *Writer) Write(ctx context.Context, tx *ent.Tx, e Entry) error {
	return w.WriteBatch(ctx, tx, []Entry{e})
}

// WriteBatch 一次写多条：同一批同一个 created_at。
//
// 逐条 Exec 而不是拼一条多行 INSERT：审计一批最多几条（顶层权限替换那种），
// 省下的往返换不来拼占位符的复杂度。
func (w *Writer) WriteBatch(ctx context.Context, tx *ent.Tx, es []Entry) error {
	if len(es) == 0 {
		return nil
	}
	var ex execer = w.db
	if tx != nil {
		ex = tx
	}
	now := w.clk.Now()
	for _, e := range es {
		if e.Action == "" || e.TargetType == "" || e.TargetID == "" {
			// 三列都是 NOT NULL 且有非空 CHECK（ck_audit_logs_target_nonempty）：
			// 空值会让整条业务事务回滚，报错停在 PG 的错误信息上，离真正的调用点很远。
			return fmt.Errorf("audit: action/target_type/target_id 不能为空: %+v", e)
		}
		if _, err := ex.ExecContext(ctx, sqlInsert,
			actorID(e.ActorID), e.Action, e.TargetType, e.TargetID, detailJSON(e.Detail), ipOrNull(e.IP), now); err != nil {
			return fmt.Errorf("audit: write %s %s/%s: %w", e.Action, e.TargetType, e.TargetID, err)
		}
	}
	return nil
}
