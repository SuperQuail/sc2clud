package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// DonationNoticeDefault 按渠道的默认打赏提示文案（d6-reward.md §3.2 第 3 张；表 donation_notice_defaults）。
//
// 留给手写迁移：
//   - PRIMARY KEY (channel)
//   - ck_donation_notice_defaults_channel CHECK (channel IN ('default','wechat','alipay','other'))
//     —— 这 4 个值**不进**枚举自检名单：它们不参与任何判定，未知值回落 default 行（d6 §3.3）
type DonationNoticeDefault struct {
	ent.Schema
}

// Fields 见 d6-reward.md §4.3。
func (DonationNoticeDefault) Fields() []ent.Field {
	return []ent.Field{
		field.String("channel").MaxLen(16).Comment("主键；手写迁移里是 PRIMARY KEY"),
		field.String("text").MaxLen(200).Default(""),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Indexes：channel 唯一（手写迁移里改成 PRIMARY KEY）。
func (DonationNoticeDefault) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("channel").Unique(),
	}
}
