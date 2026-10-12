package schema

import (
	"encoding/json"
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// MailLog 每封邮件一条（d6-reward.md §3.2 第 13 张；表 mail_logs）。邮件是排障证据，暂不清理（拍板 §8.11 U8）。
//
// idempotency_key **NOT NULL + 唯一**：可空的话 NULL 行不受约束，幂等会静默失效（d6 §3.3）。
// to 是 SQL 关键字，所以列名是 to_address。
//
// 留给手写迁移：
//   - uq_mail_logs_idem UNIQUE (idempotency_key)
//   - ck_mail_logs_status   CHECK (status IN ('pending','sent','failed'))
//   - ck_mail_logs_template CHECK (template IN ('verify_email','reset_password','test','notice'))
//   - ck_mail_logs_attempts CHECK (attempts >= 0)
//   - idx_mail_logs_status (status, created_at DESC)
//   - idx_mail_logs_quota_account 外键索引
type MailLog struct {
	ent.Schema
}

// Fields 见 d6-reward.md §4.8。
func (MailLog) Fields() []ent.Field {
	return []ent.Field{
		field.String("idempotency_key").MaxLen(128).Unique(),
		field.String("to_address").MaxLen(254),
		field.String("template").MaxLen(64),
		field.JSON("payload", json.RawMessage{}).Default(json.RawMessage("{}")),
		field.String("status").MaxLen(8).Default("pending"),
		field.String("provider").MaxLen(32).Default(""),
		field.Text("provider_message_id").Optional().Nillable(),
		field.Text("error").Optional().Nillable(),
		field.Int("attempts").Default(0),
		field.Int64("quota_account_id").Optional().Nillable().Comment("占的是哪个账号的额度"),
		field.Time("quota_day").Optional().Nillable().
			SchemaType(map[string]string{dialect.Postgres: "date"}),
		field.Time("sent_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：quota_account 侧 SET NULL（账号可以删，日志要留）。
func (MailLog) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("quota_account", MailAccount.Type).Ref("mail_logs").Field("quota_account_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：idx_mail_logs_status (status, created_at) 与 idx_mail_logs_quota_account（外键索引）。
func (MailLog) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("status", "created_at"),
		index.Fields("quota_account_id"),
	}
}
