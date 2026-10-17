package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// UserTitle 用户持有的头衔（d4-social.md §1.4；表 user_titles）。**多对多：一个用户可持多个头衔**。
//
// 没有 public_id：它是纯关联行，对外用 user + title 表达（d4 §1.6）。
//
// 留给手写迁移：
//   - PRIMARY KEY (user_id, title_id)
//   - ck_user_titles_not_self CHECK (granted_by IS NULL OR granted_by <> user_id)
//   - 外键索引 idx_user_titles_title (title_id)、idx_user_titles_granted (granted_by)
//     —— 主键第二列不算「已索引」（拍板 §5.9 第 6 条）
type UserTitle struct {
	ent.Schema
}

// Fields 见 d4-social.md §1.4。
func (UserTitle) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("user_id"),
		field.Int64("title_id"),
		field.Int64("granted_by").Optional().Nillable().Comment("发头衔的人；NULL = 系统发放"),
		field.Time("granted_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：两侧 CASCADE；granted_by 侧 SET NULL（users 永不硬删）。
func (UserTitle) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("title", Title.Type).Field("title_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("granter", User.Type).Field("granted_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：(user_id,title_id) 唯一（手写迁移里是 PRIMARY KEY）+
// 两条外键索引（title_id 是主键第二列、granted_by 不在任何索引前导位）。
func (UserTitle) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "title_id").Unique(),
		index.Fields("title_id"),
		index.Fields("granted_by"),
	}
}
