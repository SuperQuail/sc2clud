package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
)

// AuditLog 审计日志（d2-auth.md §5.8；表 audit_logs）。
//
// 只增不改的流水表：没有 updated_at（数据库文档 §2 第 12 条：会变的表才加）。
// 不做分区、不做归档：量级是「管理员动作」，一年几千行（D2 §5.8）。
//
// detail 只有两个形状：{"before": …} 与 {"before": …, "after": …}；
// 不写「操作描述」——那是 action 的活。写入的唯一入口是 authSvc.AuditWriter()。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_audit_logs_target_nonempty CHECK (btrim(target_id) <> '')
//   - 三条复合索引的 DESC 方向与列序（服务三个真实查询，列序与游标同序）：
//       idx_audit_logs_actor  (actor_id, created_at DESC, id DESC)              actor= 筛选
//       idx_audit_logs_target (target_type, target_id, created_at DESC, id DESC) target_type=&target_id= 筛选
//       idx_audit_logs_dump   (created_at DESC, id DESC)                        全量导出（时间范围 + 游标）
//     ent 的 index.Fields 声明不了 DESC，所以这里一条都不声明，全部只在迁移里写，
//     否则两条 DDL 路径会比出「同名不同方向」的索引。
//   - **刻意不加 idx_audit_logs_action**：action= 是低频高选择性筛选，顺扫可接受（D2 §5.8）
//   - actor_id 的外键索引就是 idx_audit_logs_actor 的前导列，不另建
type AuditLog struct {
	ent.Schema
}

// Fields 见 d2-auth.md §5.8。
func (AuditLog) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("actor_id").Optional().Nillable().
			Comment("操作者；CLI 与系统动作为 NULL。FK users(id) ON DELETE SET NULL"),
		field.String("action").MaxLen(64).
			Comment("动作名，如 role.grant / permission.expire（枚举由 audit.Writer 收口）"),
		field.String("target_type").MaxLen(32).
			Comment("user / role / board / permission / mail_account …"),
		field.String("target_id").MaxLen(64).
			Comment("存 public_id 或业务 key 的字符串，**不存自增 id**（数据库文档 §2 第 3 条）"),
		field.JSON("detail", map[string]any{}).Default(map[string]any{}).
			Comment("before / after 快照；只这两个形状"),
		field.String("ip").
			SchemaType(map[string]string{dialect.Postgres: "inet"}).
			Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：actor 侧 SET NULL——操作者注销后审计行必须还在。
func (AuditLog) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("actor", User.Type).Field("actor_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}
