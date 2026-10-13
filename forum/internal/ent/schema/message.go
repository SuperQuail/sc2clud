package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"

	"forum/internal/ent/schema/mixin"
)

// Message 一对一私信（d4-social.md §1.3；表 messages）。
//
// **不做会话表**：(low_id, high_id) 就是会话身份，规范化顺序由 CHECK 保证；
// 两条删除位代替两行（一人一条会翻倍写与分页复杂度）。
//
// 留给手写迁移：
//   - ck_messages_pair_order     CHECK (low_id < high_id)
//   - ck_messages_sender_in_pair CHECK (sender_id IN (low_id, high_id))
//   - ck_messages_body_not_blank CHECK (btrim(body) <> ”)
//   - idx_messages_pair_low  (low_id,  high_id, id DESC)
//   - idx_messages_pair_high (high_id, low_id,  id DESC)  —— 两侧都要，否则 high 一侧全表扫
//   - idx_messages_unread_low  ON (low_id)  WHERE read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id
//   - idx_messages_unread_high ON (high_id) WHERE read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id
//     —— sender_id <> 我 是必需的：read_at 是**收件人**的已读时间，漏掉会把自己发的消息计进自己的未读角标
type Message struct {
	ent.Schema
}

// Mixin：public_id（DELETE /messages/{id} 按它对地址）。
func (Message) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d4-social.md §1.3。
func (Message) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("low_id").Comment("规范化用户对：恒为较小的 user id"),
		field.Int64("high_id"),
		field.Int64("sender_id").Comment("必为 low_id / high_id 之一（CHECK）"),
		field.String("body").MaxLen(2000).Comment("纯文本，私信不做 Markdown 渲染"),
		field.Time("read_at").Optional().Nillable().Comment("收件人的已读时间"),
		field.Bool("deleted_by_low").Default(false),
		field.Bool("deleted_by_high").Default(false),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：三条都 CASCADE。
func (Message) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("low", User.Type).Field("low_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("high", User.Type).Field("high_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("sender", User.Type).Field("sender_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

// Indexes：会话两侧的锚点、两条未读部分索引（谓词必须带收件人条件与删除条件）、sender 外键索引。
func (Message) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("low_id", "high_id", "id"),
		index.Fields("high_id", "low_id", "id"),
		index.Fields("low_id").
			Annotations(entsql.IndexWhere("read_at IS NULL AND deleted_by_low = false AND sender_id <> low_id")),
		index.Fields("high_id").
			Annotations(entsql.IndexWhere("read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id")),
		index.Fields("sender_id"),
	}
}
