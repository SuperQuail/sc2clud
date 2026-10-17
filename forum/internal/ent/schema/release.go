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

// Release 启动器版本（d5-content.md §5.1；表 releases）。**本站不承载产物字节，只做索引与 302 转链。**
//
// version **全局唯一**（不按 channel 分开）——拍板 §8.9：同号两通道会让人下错。
// 状态机与 published_at 的一致性（published_at 非空 ⟺ status='published'）写在手写迁移的
// ck_releases_published_at 里，见 0012_release.up.sql。
//
// 留给手写迁移：
//   - ck_releases_channel CHECK (channel IN ('stable','beta'))
//   - ck_releases_status  CHECK (status IN ('draft','published','archived'))
//   - ck_releases_published_at（状态机不变量）
//   - idx_releases_latest (status, channel, published_at DESC, id DESC)
//   - ALTER TABLE ... SET (autovacuum_*) —— 持续更新的表，收紧 autovacuum
type Release struct {
	ent.Schema
}

// Mixin：public_id。
func (Release) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d5-content.md §5.1。
func (Release) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("version").MaxLen(32).Unique(),
		field.String("channel").MaxLen(8).Default("stable").Comment("stable / beta"),
		field.Text("notes_md").Default(""),
		field.Text("notes_html").Default("").Comment("goldmark + bluemonday，与帖子同一套"),
		field.Time("published_at").Optional().Nillable(),
		field.String("status").MaxLen(16).Default("draft"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：资产（release_assets，CASCADE）。
func (Release) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("assets", ReleaseAsset.Type).Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：version 唯一（列上的 Unique）。
// 【手写】idx_releases_latest (status, channel, published_at DESC, id DESC) —— 「最新 stable」与
// 历史列表共用，且与游标排序键同序（拍板 §5.9 第 4 条）。ent 表达不了 DESC，只在迁移里写。
func (Release) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("version").Unique(),
	}
}
