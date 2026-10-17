package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
)

// Session 登录会话（d2-auth.md §5.2；表 sessions）。
//
// **没有 public_id**：会话列表要能踢单条，那个 {id} 用 token_hash 的 base64url 前 16 字节（22 字符）——
// 它已唯一、已不可反推，再加一列 public_id 是纯冗余（D2 §5.2 的定案，U13 的另一支被否）。
// 与之对应，删除走 WHERE token_hash = $1（uq_sessions_token），不需要第二条唯一索引。
//
// 不存 updated_at：last_seen_at 就是它。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_sessions_hash_len CHECK (octet_length(token_hash) = 32)
//   - uq_sessions_token     UNIQUE (token_hash)   —— Resolve 与批量 touch 的唯一热路径
//   - idx_sessions_user     (user_id)             —— 纯外键索引（删用户级联）
//   - idx_sessions_expires  (expires_at)          —— PruneSessions 的范围扫；**普通索引不是部分索引**
//     （部分索引会被数据库文档 §12 第 1 条的外键索引自检判为不可用，D2 §5.2 特意说明）
type Session struct {
	ent.Schema
}

// Fields 见 d2-auth.md §5.2。
func (Session) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Bytes("token_hash").
			Comment("原始 token 的 SHA-256（32 字节）；长度 CHECK 在迁移"),
		field.Int64("user_id").
			Comment("FK users(id) ON DELETE CASCADE"),
		field.String("csrf_token").MaxLen(64).
			Comment("随 Principal 下发"),
		field.String("ip").MaxLen(45).
			Comment("PG 侧是 inet（0003_authz 建表写死）。ent 表达不了列类型：v0.14 的 entsql.Annotation 没有 Type 字段，\nfield.String 在 PG 上生成 varchar(45) 足够装下带端口的 IPv6 文本，迁移侧才是类型真源"),
		field.String("user_agent").Default(""),
		field.Time("expires_at").
			Comment("过期时刻；清理任务删「过期 ≥7 天」的行（D2 §5.2）"),
		field.Time("last_seen_at").Default(time.Now).
			Comment("批量刷写的节流时间戳（D2 §6.5）"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：删用户级联删会话（数据库文档 §2 第 11 条：users 永不硬删，CASCADE 只兜底）。
func (Session) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}
