package audit

import (
	"context"
	"database/sql"
	"encoding/json"
)

// sqlInsert 是审计行的唯一 INSERT（Write 与 WriteBatch 共用同一份列名与取值规则）。
//
// **为什么是原生 SQL 而不是 ent**：audit_logs.ip 在 0003_authz 里是 inet，而 ent 实体侧
// 是 field.String("ip").MaxLen(45)（varchar）——列类型 ent 表达不了，走 ent 的 INSERT 会被
// PG 按 text 绑参拒绝。所以写入走 tx.ExecContext（_P2-修正清单 §1；dx 里只有 Exec/QueryContext）。
const sqlInsert = `
INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)`

// execer 是 *ent.Tx 与 *sql.Stmt 共有的最小执行面（ent.Tx 的提升方法，见修正清单 §1）。
// 使用方定义接口，所以本包不必 import ent。
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// actorID 空 → NULL：CLI 与系统动作没有 actor。
func actorID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

// ipOrNull 空 → NULL：inet 列不接受空串（'' 会报 invalid input syntax for type inet）。
func ipOrNull(ip string) any {
	if ip == "" {
		return nil
	}
	return ip
}

// detailJSON nil → {}：列是 NOT NULL，显式写比依赖列默认值清楚。
func detailJSON(d map[string]any) []byte {
	if len(d) == 0 {
		return []byte("{}")
	}
	b, err := json.Marshal(d)
	if err != nil {
		// detail 的值来自我们自己构造的 DTO，序列化不了就是代码 bug。
		// 写空对象而不是报错：让业务事务成功、审计留下这条行，比整条业务回滚好。
		return []byte("{}")
	}
	return b
}
