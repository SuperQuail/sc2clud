package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"

	"forum/internal/ent/schema/mixin"
)

// Report 举报（d6-reward.md §4；表 reports。d3 §4.8 明说举报不属论坛域，
// 但表在 forum 的 schema 里，落点见 d1 §8.1）。
// 多态目标（topic / post / user）与 likes 同理：**没有外键**，孤儿行由自检 SQL 兜。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_reports_target_type CHECK (target_type IN ('topic','post','user'))；
//   - ck_reports_state CHECK (state IN ('open','handled','dismissed'))；
//   - ck_reports_handled CHECK ((state='open' AND handler_id IS NULL AND handled_at IS NULL) OR
//     (state IN ('handled','dismissed') AND handler_id IS NOT NULL AND handled_at IS NOT NULL))；
//   - **部分唯一索引** uq_reports_once (reporter_id, target_type, target_id) WHERE state = 'open'
//     —— 同一人对同一对象只留一条未处理的（拍板 §4；重复举报返回 200 + 既有那条）；
//   - fk_reports_reporter → users(RESTRICT)、fk_reports_handler → users(SET NULL)。
type Report struct {
	ent.Schema
}

func (Report) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

func (Report) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("target_type").SchemaType(pgType("text")).
			Comment("topic/post/user，CHECK 在迁移"),
		field.Int64("target_id").Comment("多态，无外键（见文件头）"),
		field.String("reason").MaxRuneLen(500).SchemaType(pgType("varchar(500)")),
		field.String("detail").MaxRuneLen(1000).SchemaType(pgType("varchar(1000)")).Default(""),
		field.Int64("reporter_id"),
		field.String("state").SchemaType(pgType("text")).Default("open").
			Comment("open/handled/dismissed，CHECK 在迁移"),
		field.Int64("handler_id").Optional().Nillable(),
		field.Time("handled_at").Optional().Nillable(),
		field.String("handle_note").MaxRuneLen(500).SchemaType(pgType("varchar(500)")).Default(""),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (Report) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("reporter", User.Type).Field("reporter_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("handler", User.Type).Field("handler_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

func (Report) Indexes() []ent.Index {
	return []ent.Index{
		// 处理队列（与游标排序同序）。
		index.Fields("state", "created_at", "id").
			Annotations(entsql.DescColumns("created_at", "id")).
			StorageKey("idx_reports_queue"),
		// 我发出的举报。
		index.Fields("reporter_id", "created_at", "id").
			Annotations(entsql.DescColumns("created_at", "id")).
			StorageKey("idx_reports_reporter"),
		index.Fields("handler_id").StorageKey("idx_reports_handler"), // 外键路径
		index.Fields("target_type", "target_id").StorageKey("idx_reports_target"),
	}
}
