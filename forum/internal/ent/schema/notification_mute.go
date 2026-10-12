package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// NotificationMute 「不再通知」静音（d4-social.md §1.2；表 notification_mutes）。
//
// 一行两义，由 type 区分（d4 §1.2 的表）：
//   - (u,'like',”)        整个类别不再通知
//   - (u,'link','post:42') 这条内容不再通知（target_key = ref_type:ref_id，同一个 notify.RefKey 生成）
//
// 没有 public_id：它是对外行为的**输入**（用 type + target_key 表达），不是按 id 寻址的实体（d4 §1.6）。
//
// 留给手写迁移：
//   - PRIMARY KEY (user_id, type, target_key)  —— ent 里退化成唯一索引（d4 §2.2）
//   - ck_notification_mutes_type CHECK (type IN ('reply','mention','like','reward','review','sanction','system','link'))
//   - ck_notification_mutes_key  CHECK ((type =  'link' AND target_key ~ '^(post|topic|comment|issue|donation|sanction):[0-9]+$')
//     OR (type <> 'link' AND target_key = ”))
type NotificationMute struct {
	ent.Schema
}

// Fields 见 d4-social.md §1.2。
func (NotificationMute) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("user_id"),
		field.String("type").MaxLen(16),
		field.String("target_key").MaxLen(64).Default(""),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：user 侧 CASCADE。
func (NotificationMute) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：复合业务主键在 ent 里退化成唯一索引；不引入 id 列（d4 §2.2）。
func (NotificationMute) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "type", "target_key").Unique(),
	}
}
