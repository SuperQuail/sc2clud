package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// SiteSetting 站点键值配置（d6-reward.md §3.2 第 5 张；表 site_settings）。
//
// **没有 created_at**（d6 §4.9 有意偏差 1）：这是配置快照，不是实体，updated_at 就够。
// 不预置任何行：缺 key = 用代码里的默认值（d6 §5.4）——插空行会让「默认值」有两个真源。
//
// 留给手写迁移：PRIMARY KEY (key)（ent 侧只能表达成唯一索引）。
type SiteSetting struct {
	ent.Schema
}

// Fields 见 d6-reward.md §4.5。
func (SiteSetting) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.String("key").MaxLen(64).Comment("主键；手写迁移里是 PRIMARY KEY"),
		field.Text("value").Default(""),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Indexes：key 唯一（手写迁移里改成 PRIMARY KEY）。
func (SiteSetting) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("key").Unique(),
	}
}
