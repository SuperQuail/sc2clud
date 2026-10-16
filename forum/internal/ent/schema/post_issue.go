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

// PostIssue 资源帖的问题与建议（d3-forum.md §2.1/§2.2、§7.5–§7.8；表 post_issues；迁移 0005_forum_issue）。
//
// 留给手写迁移（ent 表达不了；迁移 0005 已写）：
//   - 5 条 CHECK：kind (bug/feature/difficulty/other) / status (keep_open/closed) / number (>= 1) /
//     tags (array_length <= 5) / closed ((status = 'closed') = (closed_at IS NOT NULL))；
//   - **tags text[] NOT NULL DEFAULT '{}' 与 idx_post_issues_tags USING gin (tags)**：
//     ent 没有 PG 数组字段类型（field.Strings 走 JSON 编解码，写 text[] 会炸），
//     这一列不进 ent 模型，标签的读写走 pgsql 原生 SQL；
//   - 【现状】post_issues 没有 tsv 生成列：0016_search 只建了 topic_search.tsv。
//     d3 §12.2 第 4 条要求给 issue 也加检索列（全站 Issue 的 ?q= 目前没有索引支撑）—— 未决；
//   - 部分唯一索引 uq_post_issues_author_client_token (author_id, client_token) WHERE client_token <> ”。
//
// 取号：number 在创建事务里按 topic 取，UNIQUE (topic_id, number) 兜底（d3 §7.6）。
type PostIssue struct {
	ent.Schema
}

func (PostIssue) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

func (PostIssue) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("topic_id"),
		field.Int64("author_id"),
		field.Int64("assignee_id").Optional().Nillable().
			Comment("指派给谁。?assignee=me 的落点；不接受 assignee=别人（否则它变成别人的筛选器）"),
		field.Int32("number").Comment("帖内编号（#12）；响应同时给 public_id 与它"),
		field.String("kind").SchemaType(pgType("text")).
			Comment("bug/feature/difficulty/other，CHECK 在迁移（四类，界面施工 §3.2）"),
		field.String("title").MaxRuneLen(120).SchemaType(pgType("varchar(120)")),
		field.String("body_md").SchemaType(pgType("text")),
		field.String("body_html").SchemaType(pgType("text")),
		field.String("body_text").SchemaType(pgType("text")).Default("").
			Comment("正文纯文本，供 tsv 生成列使用（D5 的 PlainText）"),
		field.String("status").SchemaType(pgType("text")).Default("keep_open").
			Comment("keep_open/closed，CHECK 在迁移。API 的 ?status=open|closed 在 service 里换算"),
		field.Int64("closed_by").Optional().Nillable().Comment("关闭人；FK users(id) ON DELETE SET NULL"),
		field.Time("closed_at").Optional().Nillable(),
		field.String("client_token").MaxLen(64).SchemaType(pgType("varchar(64)")).Default(""),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (PostIssue) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("topic", Topic.Type).Field("topic_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("author", User.Type).Field("author_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("assignee", User.Type).Field("assignee_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
		edge.To("closer", User.Type).Field("closed_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

func (PostIssue) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("topic_id", "number").Unique().StorageKey("uq_post_issues_topic_number"),
		index.Fields("status", "updated_at", "id").
			Annotations(entsql.DescColumns("updated_at", "id")).
			StorageKey("idx_post_issues_global"),
		index.Fields("topic_id", "status", "updated_at", "id").
			Annotations(entsql.DescColumns("updated_at", "id")).
			StorageKey("idx_post_issues_topic_status"),
		index.Fields("author_id", "id").
			Annotations(entsql.DescColumns("id")).
			StorageKey("idx_post_issues_author"),
		// 两条纯外键索引：ASSIGNEE/CLOSED_BY 都是 SET NULL，引用完整性查找用不了部分索引。
		index.Fields("assignee_id").StorageKey("idx_post_issues_assignee"),
		index.Fields("closed_by").StorageKey("idx_post_issues_closed_by"),
	}
}
