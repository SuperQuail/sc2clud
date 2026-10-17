package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Block 拉黑（d3-forum.md §2.1、§4.1.1 末；表 blocks）。方向性明确：
// A 拉黑 B 不影响 B 看 A 的内容，只挡「B 回复/私信 A」。判定时双向任一命中即拒，且不说是谁（d4 §5.2）。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_blocks_not_self CHECK (user_id <> target_user_id)；
//   - 主键 (user_id, target_user_id)：ent 的表都带 id 列，所以自然键写成唯一索引（见回报）；
//   - fk_blocks_user / fk_blocks_target → users(CASCADE)。
type Block struct {
	ent.Schema
}

func (Block) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("user_id"),
		field.Int64("target_user_id"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (Block) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("target", User.Type).Field("target_user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

func (Block) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "target_user_id").Unique(),
		index.Fields("target_user_id").StorageKey("idx_blocks_target"), // 外键路径（级联删用户）
	}
}
