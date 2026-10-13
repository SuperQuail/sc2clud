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

// PaymentChannel 作者挂的收款码（d5-content.md §2.1、§3.3；表 payment_channels；建表在 0010_media）。
//
// 图**固定私有**（images.visibility = 2 语义）——拍板 §8.7：老站「收款码 404」的根治做法。
// 可见性判定只发生在渠道读端点一处（GET /users/{handle}/channels），不在 images 上加第四档。
//
// **只有 created_at，没有 updated_at**：与 0010_media.up.sql 的实际列一致
// （d5 §2.1 也没列 updated_at；渠道是「删了重建」，不原地改）。
//
// 留给手写迁移：
//   - ck_payment_channels_label CHECK (btrim(label) <> ”)
//   - ck_payment_channels_sort  CHECK (sort >= 0)
//     「每用户 ≤5」是 service 层判定（d5 §3.4），不是 CHECK。
type PaymentChannel struct {
	ent.Schema
}

// Mixin：public_id（端点 DELETE /me/payment-channels/{id} 按它对地址）。
func (PaymentChannel) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 0010_media.up.sql。
func (PaymentChannel) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("user_id"),
		field.String("label").MaxLen(32),
		field.String("image_hash").MaxLen(64).Comment("char(64)；images.hash"),
		field.Int("sort").Default(0),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：user 侧 CASCADE；图侧 RESTRICT（先换图再删渠道，避免引用计数被悄悄减到 0）。
func (PaymentChannel) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("donations", DonationRecord.Type),
	}
}

// Indexes：idx_payment_channels_user (user_id, sort) —— 渠道列表按 sort 排；
// image_hash 是 RESTRICT 外键，同样要单列索引（0010_media 里是 idx_payment_channels_image）。
func (PaymentChannel) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "sort"),
		index.Fields("image_hash"),
	}
}
