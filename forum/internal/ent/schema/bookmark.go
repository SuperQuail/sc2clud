package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Bookmark 收藏主题（d3-forum.md §2.1、§5.4、§3.6；表 bookmarks；迁移 0006_social）。
// 幂等：PUT 用 ON CONFLICT DO NOTHING（收藏时间就该是第一次的时间），DELETE 未收藏时也是 200。
//
// 留给手写迁移（ent 表达不了；迁移 0006 已写）：
//   - 主键 (user_id, topic_id)：ent 的表都带 id 列，所以自然键写成唯一索引（见回报「与设计不一致」）；
//   - fk_bookmarks_user → users(CASCADE)、fk_bookmarks_topic → topics(CASCADE)。
type Bookmark struct {
	ent.Schema
}

func (Bookmark) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("user_id"),
		field.Int64("topic_id"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (Bookmark) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("topic", Topic.Type).Field("topic_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

func (Bookmark) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "topic_id").Unique(),
		// 收藏页按收藏时间倒序翻：user_id 等值 + 与排序键同序。
		// 表里没有 id 列，游标就是 created_at（迁移 0006 的裁决：不为游标兜底造一个 id 列）。
		index.Fields("user_id", "created_at").
			Annotations(entsql.DescColumns("created_at")).
			StorageKey("idx_bookmarks_user"),
		// topic_id 的外键路径（复合主键的第二列不算已索引）。
		index.Fields("topic_id").StorageKey("idx_bookmarks_topic"),
	}
}
