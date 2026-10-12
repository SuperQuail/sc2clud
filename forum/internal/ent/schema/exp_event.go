package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ExpEvent 经验流水（d4-social.md §1.5；表 exp_events）。
//
// 不变量：users.level = floor(sqrt(users.exp / 100)) + 1（d4 §5.4）。
// **两条书写路径：写 exp 时必须同事务重算 level**（数据库文档 §12 第 5 条自检会红）。
//
// 没有 public_id：这张表没有对外端点（d4 §1.6）。
//
// 留给手写迁移：
//   - ck_exp_events_delta_nonzero CHECK (delta <> 0)
//   - ck_exp_events_reason CHECK (reason IN ('manual','register','topic','reply','like','reward','import'))
//     —— 值域 = Go 常量 title.Reason*，逐字同名（自检比对）
//   - ck_exp_events_ref CHECK (ref = ” OR ref ~ '^[a-z_]+:[0-9]+$')
//   - uq_exp_events_user_reason_ref UNIQUE (user_id, reason, ref) WHERE ref <> ”
//     —— 幂等键：队列重试、并发重放都不重复加经验
type ExpEvent struct {
	ent.Schema
}

// Fields 见 d4-social.md §1.5。
func (ExpEvent) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("user_id"),
		field.Int("delta").Comment("可正可负，但不得为 0（CHECK）"),
		field.String("reason").MaxLen(32),
		field.String("ref").MaxLen(64).Default("").Comment("<实体>:<内部id>，如 post:42"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：user 侧 CASCADE。
func (ExpEvent) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：(user_id, created_at DESC, id DESC) 游标 + (user_id, reason, ref) 幂等唯一。
func (ExpEvent) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "created_at", "id"),
		index.Fields("user_id", "reason", "ref").Unique().
			Annotations(entsql.IndexWhere("ref <> ''")),
	}
}
