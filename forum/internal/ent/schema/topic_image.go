package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// TopicImage 帖子配图关联（d3-forum.md §2.1、d5 §4.1；表 topic_images；迁移 0004_forum）。
// 图片字节归 D5。主键 (topic_id, post_id, image_hash) 同时是**封面查询的索引**：
// topic_id 等值 + post_id = 第一层的 id（d3 §3.2 的 LATERAL）。
//
// 留给手写迁移（ent 表达不了；迁移 0004 已写）：
//   - 主键 (topic_id, post_id, image_hash)：ent 的表都带 id 列，所以自然键写成唯一索引
//     （见回报「与设计不一致」）；
//   - ck_topic_images_sort CHECK (sort BETWEEN 0 AND 8)（「每帖 ≤9 张」的落点）；
//   - fk_topic_images_hash → images(hash) RESTRICT：目标不是 images 的 ent ID，所以 schema 里不建边。
//
// refcount 的加减与本表的行同事务（d5 §2.2 的时机表）。
type TopicImage struct {
	ent.Schema
}

func (TopicImage) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("topic_id"),
		field.Int64("post_id"),
		field.String("image_hash").MaxLen(64).SchemaType(pgType("char(64)")).
			Comment("D5 images.hash；FK 在迁移里（见文件头）"),
		field.Int32("sort").Default(0).Comment("图集顺序；0..8（CHECK 在迁移）"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (TopicImage) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("topic", Topic.Type).Field("topic_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("post", Post.Type).Field("post_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

func (TopicImage) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("topic_id", "post_id", "image_hash").Unique(),
		index.Fields("topic_id", "post_id", "sort").Unique().StorageKey("uq_topic_images_sort"),
		// 复合自然键的第二/三列不算已索引：删楼层扫 post_id、删图片扫 image_hash。
		index.Fields("post_id").StorageKey("idx_topic_images_post"),
		index.Fields("image_hash").StorageKey("idx_topic_images_hash"),
	}
}
