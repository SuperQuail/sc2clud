package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Image 内容寻址图片（d5-content.md §2.1；表 images；建表在 0002_accounts，理由见该文件头）。
//
// 主键是 sha256 hex 本身（hash 即对外标识，URL 形状 /img/<hash>），**没有 public_id**：
// 它不是自增 id 寻址的实体，也就不需要第二个对外 ID（d4 §1.6 同款判断）。
//
// 列类型按**已执行的迁移**（0002_accounts.up.sql）写，两处与 d5 §2.1 的措辞不同：
//   - hash 是 char(64)（d5 写 text + CHECK；迁移选了定长，值域由 ck_images_hash_fmt 兜住）；
//   - visibility 是 smallint 0/1/2（d5 §12.1 裁决 2 想要 text 三值，但这里跟随已落地的 DDL，
//     否则 ent 的 Schema.Create 会去 ALTER 一个正在正常工作的列）。
//     这两处要的是「改迁移」而不是「改 schema」，已登记在回报的「与设计不一致」一节。
//
// 留给手写迁移（ent 表达不了）：
//   - 主键 (hash)
//   - ck_images_hash_fmt   CHECK (hash ~ '^[0-9a-f]{64}$')
//   - ck_images_size_pos   CHECK (size > 0)
//   - ck_images_mime       CHECK (mime IN ('image/png','image/jpeg','image/gif','image/webp'))
//     —— SVG 不在列表里（可内嵌脚本），由 CHECK 兜住
//   - ck_images_dims       CHECK (width >= 0 AND height >= 0)
//   - ck_images_refcount   CHECK (refcount >= 0)
//   - ck_images_visibility CHECK (visibility IN (0,1,2))
//   - idx_images_gc ON images (refcount) WHERE refcount = 0 —— 部分索引，GC 任务扫它
type Image struct {
	ent.Schema
}

// Fields 见 0002_accounts.up.sql。
func (Image) Fields() []ent.Field {
	return []ent.Field{
		field.String("hash").MaxLen(64).Comment("char(64)，sha256 hex；主键，同时是对外标识"),
		field.Int64("size").Comment("真实字节数"),
		field.Text("mime").Comment("四值枚举，CHECK 在手写迁移"),
		field.Int("width").Default(0),
		field.Int("height").Default(0),
		field.Int("refcount").Default(1).Comment("归零才可能被回收；加/减时机见 d5 §2.2"),
		field.Int("visibility").Default(0).
			Comment("0 公开 / 1 登录可见 / 2 本人与管理员；CHECK 在手写迁移"),
		field.Int64("owner_id").Optional().Nillable().Comment("users.id；FK 在 0003_authz 补"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：owner 侧 SET NULL（users 永不硬删，数据库文档 §2 第 11 条）。
func (Image) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("owner", User.Type).Ref("images").Field("owner_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：owner_id 是外键，PG 不自动建索引，必须显式建（数据库文档 §2 第 10 条）。
// 部分索引 idx_images_gc 只在手写迁移里（schema 侧的 where 注解不生成迁移）。
func (Image) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("owner_id"),
	}
}
