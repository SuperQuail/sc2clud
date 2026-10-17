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

// ReleaseAsset 一个版本的平台/架构产物（d5-content.md §5.1；表 release_assets）。
//
// url 是**外部直链**，表上没有字节（后端方案第 11 章）。
//
// 留给手写迁移：
//   - ck_release_assets_url    CHECK (url ~ '^https?://')  —— 信任边界校验，不是内部防御；
//     没有它，一条 javascript:/file: 直链就是开放重定向与协议走私
//   - ck_release_assets_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$')
//   - ck_release_assets_size / ck_release_assets_count CHECK (>= 0)
//   - uq_release_assets_slot UNIQUE (release_id, platform, arch)
//
// platform / arch **不做 CHECK 枚举**：以后加平台不该改迁移（与 boards 表驱动的理由一致）。
// download_count 由 counter 缓冲批量写回（禁止每请求 UPDATE，d5 §5.2）。
type ReleaseAsset struct {
	ent.Schema
}

// Mixin：public_id（GET /launcher/assets/{id}/go 的 {id} 就是它，d5 §12.1 裁决 6）。
func (ReleaseAsset) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d5-content.md §5.1。
func (ReleaseAsset) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("release_id"),
		field.String("platform").MaxLen(16).Comment("windows / macos / linux"),
		field.String("arch").MaxLen(16).Comment("x86_64 / arm64"),
		field.Text("url").Comment("外部直链，只收 http(s)"),
		field.Int64("size").Default(0),
		field.String("sha256").MaxLen(64),
		field.Int64("download_count").Default(0),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：release 侧 CASCADE。
func (ReleaseAsset) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("release", Release.Type).Ref("assets").Field("release_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：idx_release_assets_release 是外键索引（PG 不自动建）。
// 【手写】uq_release_assets_slot UNIQUE (release_id, platform, arch)。
func (ReleaseAsset) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("release_id", "platform", "arch").Unique(),
		index.Fields("release_id"),
	}
}
