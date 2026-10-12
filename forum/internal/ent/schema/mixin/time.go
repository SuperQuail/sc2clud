package mixin

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/schema/field"

	"entgo.io/ent/schema/mixin"
)

// Time 给表加 created_at / updated_at（数据库文档 §2 第 12 条：每张表都有 created_at，会变的加 updated_at）。
// **在应用层写，不建触发器**；DDL 默认值由 ent 的 DefaultExpr 给出（见 DefaultCreatedAt）。
type Time struct{ mixin.Schema }

func (Time) Fields() []ent.Field {
	return []ent.Field{
		field.Time("created_at").Immutable().Default(time.Now),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}

// CreatedOnly 给「只增不改」的表用（流水、日志）：只有 created_at，没有 updated_at。
type CreatedOnly struct{ mixin.Schema }

func (CreatedOnly) Fields() []ent.Field {
	return []ent.Field{field.Time("created_at").Immutable().Default(time.Now)}
}
