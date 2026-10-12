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

// Announcement 系统公告（d6-reward.md §3.2 第 7 张；表 announcements）。
//
// 独立于帖子：只有 site.setting 能发（d6 §6.8）。published_at 为 NULL = 草稿。
//
// 留给手写迁移：
//   - idx_announcements_published (published_at DESC, id DESC) WHERE enabled AND published_at IS NOT NULL
//     —— 部分索引，草稿不进索引；谓词只引用列（拍板 §5.9 第 1 条）
//   - idx_announcements_created_by 外键索引
type Announcement struct {
	ent.Schema
}

// Mixin：public_id（/admin/announcements/{id} 与首页公告按它对地址）。
func (Announcement) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d6-reward.md §4.7。
func (Announcement) Fields() []ent.Field {
	return []ent.Field{
		field.String("title").MaxLen(120),
		field.Text("body_md"),
		field.Text("body_html").Comment("goldmark + bluemonday，与帖子同一套"),
		field.Bool("enabled").Default(true),
		field.Time("published_at").Optional().Nillable().Comment("NULL = 草稿"),
		field.Int64("created_by").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：created_by 侧 SET NULL。
func (Announcement) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("creator", User.Type).Field("created_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：published_at（游标列）与 created_by（外键索引）。部分谓词只在手写迁移里。
func (Announcement) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("published_at", "id").
			Annotations(entsql.IndexWhere("enabled AND published_at IS NOT NULL")),
		index.Fields("created_by"),
	}
}
