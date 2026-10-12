package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// DefaultAvatar 默认头像池（d5-content.md §2.1；表 default_avatars；建表在 0002_accounts）。
//
// 池子只有几十行；无头像用户在**注册时**按 users.id 分一次并写进 users.default_avatar_hash，
// 之后永不重算（拍板 §8.8），所以注册热路径不查这张表。
//
// 留给手写迁移：主键 (hash)、hash 的外键 REFERENCES images(hash) ON DELETE CASCADE。
// 池子里的图 refcount 恒为 0，靠 image:gc 的 NOT EXISTS 排除（d5 §2.2）。
type DefaultAvatar struct {
	ent.Schema
}

// Fields 见 0002_accounts.up.sql。
func (DefaultAvatar) Fields() []ent.Field {
	return []ent.Field{
		field.String("hash").MaxLen(64).Comment("char(64)；images.hash"),
		field.Int("sort").Default(0),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：hash 指向 images，CASCADE。
func (DefaultAvatar) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("image", Image.Type).Field("hash").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：hash 唯一（手写迁移里就是 PRIMARY KEY）。
func (DefaultAvatar) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("hash").Unique(),
	}
}
