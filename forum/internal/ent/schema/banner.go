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

// Banner 顶部横幅（d6-reward.md §3.2 第 8 张；表 banners）。
//
// 定向用**角色**（banner_roles），不用用户组；**无行 = 所有人**（拍板 §8.11 U10）。
//
// 留给手写迁移：
//   - ck_banners_kind   CHECK (kind IN ('info','warning','promo'))
//   - ck_banners_window CHECK (ends_at IS NULL OR ends_at > starts_at)
//   - idx_banners_active ON (starts_at, ends_at) WHERE enabled
//     —— 「生效中」的时间比较只能留在查询里：now() 不是 IMMUTABLE，放进谓词 PG 直接拒绝建索引
//     （拍板 §5.9 第 1 条；四处「未过期」之一）
//   - idx_banners_created_by 外键索引
type Banner struct {
	ent.Schema
}

// Mixin：public_id（/admin/banners/{id} 与「不再显示」按它对地址）。
func (Banner) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d6-reward.md §4.7。
func (Banner) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("kind").MaxLen(8).Comment("info / warning / promo"),
		field.String("text").MaxRuneLen(200),
		field.Text("url").Optional().Nillable().Comment("可选跳转链接"),
		field.Time("starts_at").Default(time.Now).Annotations(entsql.DefaultExpr("now()")),
		field.Time("ends_at").Optional().Nillable().Comment("NULL = 不过期"),
		field.Bool("enabled").Default(true),
		field.Int64("created_by").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：created_by 侧 SET NULL；roles / dismissals 两条关联边都 CASCADE。
func (Banner) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("creator", User.Type).Field("created_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
		edge.To("roles", BannerRole.Type).Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("dismissals", BannerDismissal.Type).Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：enabled + starts_at（部分谓词在手写迁移）、created_by 外键索引。
func (Banner) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("starts_at", "ends_at").Annotations(entsql.IndexWhere("enabled")),
		index.Fields("created_by"),
	}
}
