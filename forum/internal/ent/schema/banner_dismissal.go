package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// BannerDismissal 横幅「不再显示」（d6-reward.md §3.2 第 10 张；表 banner_dismissals）。
//
// 留给手写迁移：
//   - PRIMARY KEY (banner_id, user_id)
//   - uq_banner_dismissals_user UNIQUE (user_id, banner_id)
//     —— 「我关过哪些横幅」要按 (user_id, banner_id) 反查，列序与主键相反；
//     Index.Fields 只能按声明顺序生成一个方向，所以第二条只能手写（d6 §3.3）
type BannerDismissal struct {
	ent.Schema
}

// Fields 见 d6-reward.md §4.7。
func (BannerDismissal) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("banner_id"),
		field.Int64("user_id"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：两侧 CASCADE。
func (BannerDismissal) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("banner", Banner.Type).Ref("dismissals").Field("banner_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：(user_id, banner_id) 唯一（反查方向）。
func (BannerDismissal) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "banner_id").Unique(),
	}
}
