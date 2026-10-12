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

// IssueComment issue 评论（d3-forum.md §2.1；表 issue_comments）。与 posts 同构：
// parent_id 只允许一级、有 visibility 与两个计数列；**不加 number**（评论不编号，d3 §12.3-8）。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_issue_comments_visibility、ck_issue_comments_counts_nonneg；
//   - fk_issue_comments_issue → post_issues(CASCADE)、fk_issue_comments_author → users(RESTRICT)、
//     fk_issue_comments_parent → issue_comments(SET NULL)。
type IssueComment struct {
	ent.Schema
}

func (IssueComment) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

func (IssueComment) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("issue_id"),
		field.Int64("author_id"),
		field.Int64("parent_id").Optional().Nillable().Comment("楼中楼父评论；只允许一级"),
		field.String("body_md").SchemaType(pgType("text")),
		field.String("body_html").SchemaType(pgType("text")),
		field.String("visibility").SchemaType(pgType("text")).Default("normal").
			Comment("normal/hidden/deleted，CHECK 在迁移"),
		field.Int32("like_count").Default(0),
		field.Int32("dislike_count").Default(0),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (IssueComment) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("issue", PostIssue.Type).Field("issue_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("author", User.Type).Field("author_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("parent", IssueComment.Type).Field("parent_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
		edge.From("replies", IssueComment.Type).Ref("parent"),
	}
}

func (IssueComment) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("issue_id", "id").StorageKey("idx_issue_comments_issue"),
		index.Fields("author_id").StorageKey("idx_issue_comments_author"),
		index.Fields("parent_id").StorageKey("idx_issue_comments_parent"),
	}
}
