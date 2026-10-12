package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// MailQuota 每日额度账（d6-reward.md §3.2 第 12 张；表 mail_quota）。
//
// **必须持久化，禁止放内存**：重启把额度清了就等于没有额度。
// day 用 PG 原生 date（不是字符串，也不是 timestamptz）——ent 侧靠 SchemaType 映射，
// 落 DDL 时要核对不是 timestamptz（d6 §3.3）。
//
// 留给手写迁移：
//   - PRIMARY KEY (account_id, day)
//   - ck_mail_quota_count CHECK (count >= 0)
//
// account_id 是主键首列 → 外键级联路径已覆盖，不需要额外索引。
type MailQuota struct {
	ent.Schema
}

// Fields 见 d6-reward.md §4.8。
func (MailQuota) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("account_id"),
		field.Time("day").SchemaType(map[string]string{dialect.Postgres: "date"}).
			Comment("PG 原生 date；一天一行"),
		field.Int("count").Default(0),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：account 侧 CASCADE。
func (MailQuota) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("account", MailAccount.Type).Ref("quota_days").Field("account_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：(account_id, day) 唯一（手写迁移里改成 PRIMARY KEY）。
func (MailQuota) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("account_id", "day").Unique(),
	}
}
