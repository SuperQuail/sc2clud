package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"

	"forum/internal/ent/schema/mixin"
)

// Session 登录会话（d2-auth.md §5.2；表 sessions）。
//
// 不存 updated_at：last_seen_at 就是它（D2 §5.2 的取舍）。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_sessions_hash_len CHECK (octet_length(token_hash) = 32)
//   - uq_sessions_token     UNIQUE (token_hash)   —— Resolve 与批量 touch 唯一热路径
//   - idx_sessions_user     (user_id)             —— 纯外键索引（删用户级联）
//   - idx_sessions_expires  (expires_at)          —— PruneSessions 的范围扫；**普通索引不是部分索引**
//     （部分索引会被数据库文档 §12 第 1 条的外键索引自检判为不可用）
//   - public_id 的唯一约束由 mixin 生成（uq_sessions_public_id，列名由 ent 推导）
type Session struct {
	ent.Schema
}

// Mixin：public_id（拍板 U13：GET /me/sessions 的 {id} 就是它）+ 对外 ID 生成规则同 User。
func (Session) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d2-auth.md §5.2。
func (Session) Fields() []ent.Field {
	return []ent.Field{
		field.Bytes("token_hash").
			Comment("原始 token 的 SHA-256（32 字节）；长度 CHECK 在迁移"),
		field.Int64("user_id").
			Comment("FK users(id) ON DELETE CASCADE"),
		field.String("csrf_token").MaxLen(64).
			Comment("随 Principal 下发"),
		field.String("ip").
			SchemaType(map[string]string{dialect.Postgres: "inet"}).
			Comment("PG 原生 inet（数据库文档 §2 第 4 条同类态度：不给它 text 兜底）"),
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
