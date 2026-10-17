package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// SiteDomain 站点域名白名单（d6-reward.md §3.2 第 6 张；表 site_domains）。
//
// **没有 is_primary 列**——拍板 §8.11 U2：「谁是主域名」的真源是配置里的 base_url，
// 两处都写必然漂移。（数据库设计 §4.9 里那个部分唯一索引随之作废。）
//
// 写入前统一 lower() 归一化，所以不需要 lower() 表达式唯一索引（主键就是归一化后的值）。
//
// 留给手写迁移：PRIMARY KEY (domain)。
type SiteDomain struct {
	ent.Schema
}

// Fields 见 d6-reward.md §4.6。
func (SiteDomain) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("domain").MaxLen(253).Comment("主键；写前 lower() 归一化"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Indexes：domain 唯一（手写迁移里改成 PRIMARY KEY）。
func (SiteDomain) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("domain").Unique(),
	}
}
