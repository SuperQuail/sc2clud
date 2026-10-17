package schema

import (
	"encoding/json"
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"

	"forum/internal/ent/schema/mixin"
)

// MailAccount 发信账号（d6-reward.md §3.2 第 11 张；表 mail_accounts）。
//
// 凭据**加密存 bytea**（主密钥在环境变量里，不进库、不进备份）：secret_cipher + secret_nonce
// 必须同时有或同时无（CHECK）。options_json 只放非敏感项。
//
// 留给手写迁移：
//   - ck_mail_accounts_provider    CHECK (provider IN ('resend','smtp'))
//   - ck_mail_accounts_priority    CHECK (priority >= 0)
//   - ck_mail_accounts_limit       CHECK (daily_limit > 0)
//   - ck_mail_accounts_secret_pair CHECK ((secret_cipher IS NULL) = (secret_nonce IS NULL))
//   - name 的 UNIQUE（列上 Unique 已表达）
//
// reset_tz 是 IANA 名字，合法性由迁移期自检与 Go 的 time.LoadLocation 判（不是表约束）。
type MailAccount struct {
	ent.Schema
}

// Mixin：public_id（/admin/mail/accounts/{id} 按它对地址）。
func (MailAccount) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d6-reward.md §4.8。
func (MailAccount) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("name").MaxRuneLen(64).Unique(),
		field.String("provider").MaxLen(8).Comment("resend / smtp"),
		field.Int("priority").Default(0).Comment("越大越优先"),
		field.Int("daily_limit").Default(100),
		field.String("reset_tz").MaxLen(64).Default("Asia/Shanghai").Comment("IANA 名字"),
		field.String("from_address").MaxLen(254),
		field.String("from_name").MaxRuneLen(64).Default(""),
		field.JSON("options_json", json.RawMessage{}).Default(json.RawMessage("{}")),
		field.Bytes("secret_cipher").Optional().Nillable().Comment("凭据密文；与 nonce 成对"),
		field.Bytes("secret_nonce").Optional().Nillable(),
		field.Time("secret_updated_at").Optional().Nillable(),
		field.Bool("enabled").Default(true),
		field.Time("archived_at").Optional().Nillable(),
		field.Time("last_ok_at").Optional().Nillable(),
		field.Text("last_error").Optional().Nillable(),
		field.Time("last_error_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：额度账与发信日志的反向边（两张表都引用本表）。
func (MailAccount) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("quota_days", MailQuota.Type).Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("mail_logs", MailLog.Type).Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：name 唯一（列上的 Unique）。
func (MailAccount) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("name").Unique(),
	}
}
