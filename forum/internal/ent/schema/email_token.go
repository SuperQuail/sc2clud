package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
)

// EmailToken 邮箱验证 / 找回密码令牌（d2-auth.md §5.3；表 email_tokens）。
//
// 只增不改：没有 updated_at。expires_at **不给默认值**——verify 24h / reset 1h 两个值不同，
// 由应用写死并写进测试（D2 §5.3）。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_email_tokens_hash_len CHECK (octet_length(token_hash) = 32)
//   - ck_email_tokens_purpose  CHECK (purpose IN ('verify','reset'))
//     （两个 CHECK 都落在 0003_authz：表在那里建，见回报的文件归属说明）
//   - uq_email_tokens_token    UNIQUE (token_hash)
//   - uq_email_tokens_live     UNIQUE (user_id, purpose) WHERE used_at IS NULL
//     —— 「一个 purpose 只留一条未消费令牌」，也是「重发」的 ON CONFLICT 目标。
//     谓词里**不能有 now()**（非 IMMUTABLE，PG 直接拒绝建索引；拍板 §5.9 第 1 条 / U19），
//     「没过期」的判定一律留在查询里：WHERE used_at IS NULL AND expires_at > $1。
//   - idx_email_tokens_user    (user_id)     —— 纯外键索引 + 清理任务
//   - idx_email_tokens_expires (expires_at)  —— PruneEmailTokens 的范围扫（D2 §5.2）
type EmailToken struct {
	ent.Schema
}

// Fields 见 d2-auth.md §5.3。
func (EmailToken) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("user_id").
			Comment("FK users(id) ON DELETE CASCADE"),
		field.Bytes("token_hash").
			Comment("SHA-256（32 字节）；长度 CHECK 在迁移"),
		field.String("purpose").MaxLen(8).
			Comment("verify/reset，CHECK 在迁移"),
		field.Time("expires_at").
			Comment("无默认值：verify 24h、reset 1h，由应用写"),
		field.Time("used_at").Optional().Nillable().
			Comment("一次性消费；uq_email_tokens_live 的谓词就是它 IS NULL"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：删用户级联删令牌。
func (EmailToken) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}
