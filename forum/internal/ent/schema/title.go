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

// Title 头衔目录（d4-social.md §1.4；表 titles）。
//
// **头衔只归档不删除**（archived_at）：title.manage 里没有删除操作，CASCADE 只是兜底。
// 归档后目录接口不返回它，已持有的人仍然带着徽章（历史事实），但不能新佩戴。
//
// 佩戴唯一由 users.equipped_title_id 一个可空外键表达（不在本表建第二张表）：
// 那条边属 users 域，由 user.go 声明，删除动作 ON DELETE SET NULL。
//
// 留给手写迁移：
//   - ck_titles_key   CHECK (key ~ '^[a-z0-9_]{1,32}$')
//   - ck_titles_color CHECK (color = ” OR color ~ '^#[0-9a-fA-F]{6}$')
//   - ck_titles_name  CHECK (btrim(name) <> ”)
type Title struct {
	ent.Schema
}

// Mixin：public_id（/admin/titles/{id} 按它对地址）。
func (Title) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d4-social.md §1.4。
func (Title) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("key").MaxLen(32).Unique(),
		field.String("name").MaxLen(32),
		field.String("color").MaxLen(16).Default("").Comment("#rrggbb，空 = 前端用默认色"),
		field.String("description").MaxLen(200).Default(""),
		field.Time("archived_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：持有关系（user_titles）与佩戴关系（users.equipped_title_id）的反向边都在这里声明。
func (Title) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("holders", UserTitle.Type),
		edge.To("equipped_by", User.Type).Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：只有 key 唯一。
// **不给 archived_at 建索引**：目录几十行，不值得（d4 §2.4）。
func (Title) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("key").Unique(),
	}
}
