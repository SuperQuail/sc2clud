package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
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
		field.Int64("id"),
		field.String("hash").MaxLen(64).Comment("char(64)；images.hash"),
		field.Int("sort").Default(0),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：**没有 ent 边**。hash 指向的是 images(hash) 而不是 images(id)，
// 而 ent 的 edge 只能指向目标表的主键，所以那条外键只存在于手写迁移里（0002_accounts）。
// 池子的读取走平台层的原生 SQL（internal/platform/image 侧）。

// Indexes：hash 唯一（手写迁移里就是 PRIMARY KEY）。
func (DefaultAvatar) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("hash").Unique(),
	}
}
