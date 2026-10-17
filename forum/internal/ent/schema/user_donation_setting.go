package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// UserDonationSetting 打赏展示开关与文案（d6-reward.md §3.2 第 2 张；表 user_donation_settings）。
//
// 三个开关都是**收款人（作者）的**开关（拍板 §8.11 U1）：show_channels 决定挂不挂码，
// records_public 决定「我收到的打赏要不要公开列出」，两个都开才公开（缺一即私有）。
// 旧站两个开关默认都是关的，所以默认值必须是 false。
//
// 留给手写迁移：
//   - PRIMARY KEY (user_id)  —— 一人一行；ent 侧只能表达成唯一索引（d6 §3.3）
//   - 没有 ent 表达不了的 CHECK
type UserDonationSetting struct {
	ent.Schema
}

// Fields 见 d6-reward.md §4.2。
func (UserDonationSetting) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("user_id").Comment("主键；手写迁移里是 PRIMARY KEY"),
		field.Bool("show_channels").Default(false).Comment("展示收款码（旧站默认关）"),
		field.Bool("records_public").Default(false).Comment("我的打赏记录可公开（旧站默认关）"),
		field.Bool("notice_visible").Default(true).Comment("显示打赏提示文案"),
		field.String("notice_text").MaxRuneLen(200).Default("").Comment("空 = 用 donation_notice_defaults"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：user 侧 CASCADE。
func (UserDonationSetting) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：user_id 唯一（手写迁移里改成 PRIMARY KEY）。
func (UserDonationSetting) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id").Unique(),
	}
}
