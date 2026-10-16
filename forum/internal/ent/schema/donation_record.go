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

// DonationRecord 打赏申报单（d6-reward.md §3.2 第 1 张；表 donation_records）。
//
// 老设计：作者挂收款码，访客扫码后**自己申报**，管理员**人工核验**。站点不经手资金，
// 所以全表没有「余额」概念，也不存在余额不变量（d6 §6.4）。
//
// 留给手写迁移：
//   - ck_donation_records_amount   CHECK (amount_cents > 0)
//   - ck_donation_records_not_self CHECK (donor_id <> recipient_id)
//   - ck_donation_records_state    CHECK (state IN ('pending','approved','rejected','withdrawn'))
//   - ck_donation_records_verified CHECK ((state IN ('pending','withdrawn') AND verified_by IS NULL
//     AND verified_at IS NULL) OR (state IN ('approved','rejected') AND verified_by IS NOT NULL
//     AND verified_at IS NOT NULL))  —— 状态机与核验人的一致性
//   - idx_donation_records_queue     (state, created_at DESC, id DESC)
//   - idx_donation_records_recipient (recipient_id, state, created_at DESC, id DESC)
//   - idx_donation_records_donor     (donor_id, created_at DESC, id DESC)
type DonationRecord struct {
	ent.Schema
}

// Mixin：public_id（POST/DELETE /rewards/{id} 按它对地址）。
func (DonationRecord) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d6-reward.md §4.1。
func (DonationRecord) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("donor_id").Comment("打赏人"),
		field.Int64("recipient_id").Comment("收款人；check donor_id <> recipient_id"),
		field.Int64("amount_cents").Comment("金额（分），申报值"),
		field.String("txn_id").MaxRuneLen(64).Default("").Comment("用户自报的支付单号/备注"),
		field.Int64("post_id").Optional().Nillable().Comment("topics.id，可关联帖子"),
		field.Int64("channel_id").Optional().Nillable().
			Comment("payment_channels.id：当时展示的是哪张码（拍板 §8.11 U3 保留）"),
		field.String("state").MaxLen(16).Default("pending").Comment("pending/approved/rejected/withdrawn"),
		field.String("note").MaxRuneLen(200).Default("").Comment("申报留言"),
		field.Int64("verified_by").Optional().Nillable().Comment("核验人；与 state 的联合 CHECK 在手写迁移"),
		field.Time("verified_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：donor / recipient 是 RESTRICT（users 永不硬删）；verifier / post / channel 是 SET NULL。
func (DonationRecord) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("donor", User.Type).Field("donor_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("recipient", User.Type).Field("recipient_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("verifier", User.Type).Field("verified_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
		edge.From("post", Topic.Type).Ref("donations").Field("post_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
		edge.From("channel", PaymentChannel.Type).Ref("donations").Field("channel_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：三条查询各自的列序 = 游标排序键序（拍板 §5.1/§5.9 第 4 条）+ 三条外键索引。
// 队列三条在迁移里补 DESC 与 id DESC（ent 的 index 表达不了方向）。
func (DonationRecord) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("state", "created_at", "id"),
		index.Fields("recipient_id", "state", "created_at", "id"),
		index.Fields("donor_id", "created_at", "id"),
		index.Fields("post_id"),
		index.Fields("channel_id"),
		index.Fields("verified_by"),
	}
}
