package schema

import (
	"encoding/json"
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Job 任务队列（d1-platform.md §6.1；表 jobs；迁移 0015_queue）。
//
// payload 只放 id 这种最小形状，**不放业务快照**（快照会过期，拍板 §5.7）。
// 领取用一条 UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)（d1 §6.2），
// 所以并发数不受单写者限制。
//
// 与数据库文档 §4.10 的列清单差异：**没有 locked_by / finished_at**
// （d1 §6.1 为准——它们不出现在领取、恢复、清理的任何 SQL 里，属于「以后可能要」的列）；
// last_error 是 text NOT NULL DEFAULT ”（不是可空）。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_jobs_status    CHECK (status IN ('pending','running','done','dead'))
//   - ck_jobs_priority / ck_jobs_attempts / ck_jobs_max_retry CHECK (>= 0)
//   - ck_jobs_lease     CHECK (status = 'running' OR locked_until IS NULL)
//   - uq_jobs_unique_key UNIQUE (unique_key) WHERE unique_key <> ” AND status IN ('pending','running')
//     —— **必须是部分唯一索引**：普通唯一索引会让任务 done 之后永远无法再次入队
//   - idx_jobs_claim   (priority DESC, run_at, id) WHERE status = 'pending'
//   - idx_jobs_recover (locked_until) WHERE status = 'running'
//   - idx_jobs_cleanup (status, updated_at)
type Job struct {
	ent.Schema
}

// Fields 见 d1-platform.md §6.1。
func (Job) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Text("type").Comment("任务类型常量集中在 platform/queue/types.go"),
		field.JSON("payload", json.RawMessage{}).Default(json.RawMessage("{}")).
			Comment("只放 id 的最小形状"),
		field.Text("unique_key").Default("").Comment("去重键；空串不参与去重"),
		field.String("status").MaxLen(16).Default("pending"),
		field.Int("priority").Default(0).Comment("越大越优先"),
		field.Int("attempts").Default(0),
		field.Int("max_retry").Default(5),
		field.Time("run_at").Default(time.Now).Annotations(entsql.DefaultExpr("now()")),
		field.Time("locked_until").Optional().Nillable().Comment("崩溃恢复用的租约；领取时 now()+5min"),
		field.Text("last_error").Default(""),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Indexes：三条索引的谓词都只引用列（拍板 §5.9 第 1 条），生效的 DDL 在手写迁移里。
func (Job) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("unique_key").Unique().
			Annotations(entsql.IndexWhere("unique_key <> '' AND status IN ('pending','running')")),
		index.Fields("priority", "run_at", "id").
			Annotations(entsql.IndexWhere("status = 'pending'")),
		index.Fields("locked_until").
			Annotations(entsql.IndexWhere("status = 'running'")),
		index.Fields("status", "updated_at"),
	}
}
