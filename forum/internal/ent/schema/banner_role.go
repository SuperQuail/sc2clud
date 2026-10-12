package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// BannerRole 横幅按角色定向（d6-reward.md §3.2 第 9 张；表 banner_roles）。
//
// 显式关联实体，**不用 ent 的 M2M 跳过表**：因为要写 role 侧索引（d6 §4.7）。
// **无行 = 所有人**（拍板 §8.11 U10）：少一列布尔就少一处「有行但 target_all=false」的歧义。
//
// **没有 created_at**：纯关联表（d6 §4.9 有意偏差 3，与 role_permissions / topic_images 同类）。
//
// 留给手写迁移：
//   - PRIMARY KEY (banner_id, role_id)
//   - idx_banner_roles_role (role_id)：复合主键的第二列不算「已索引」，而它是级联删除的真实路径
//     （数据库文档 §12 第 1 条；拍板 §5.9 第 6 条）
type BannerRole struct {
	ent.Schema
}

// Fields 见 d6-reward.md §4.7。
func (BannerRole) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("banner_id"),
		field.Int64("role_id"),
	}
}

// Edges：两侧 CASCADE。
func (BannerRole) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("banner", Banner.Type).Ref("roles").Field("banner_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("role", Role.Type).Field("role_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：(banner_id, role_id) 唯一（手写迁移里是 PRIMARY KEY）+ role_id 外键索引。
func (BannerRole) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("banner_id", "role_id").Unique(),
		index.Fields("role_id"),
	}
}
