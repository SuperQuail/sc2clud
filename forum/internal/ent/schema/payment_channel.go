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
// 图的档位是**登录可见**（images.visibility = 1，老站那一档），而「能不能对外看到」由作者侧的
// user_donation_settings.show_channels 决定 —— 判定在**读路径**上（media 的 canView），
// 所以档位在上传之后仍可调整。2026-10-14 第三轮拍板「必须显示，按渠道显示，参考老网站」：
// 写死 public 会让档位与开关脱钩（关掉展示后图仍对全站可读），写死 private 则打赏面板永远扫不出码。
// 依据：d5-content.md §3.3 / §3.4（已按该拍板改写）。
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
		field.String("label").MaxRuneLen(32),
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
