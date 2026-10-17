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

// Post 楼层（d3-forum.md §2.1/§2.2；表 posts）。1 楼 = 主题正文。
// 楼中楼只允许一级：父必须是 parent_id IS NULL 的顶层回复，且父与本行同一 topic
// —— 跨行规则 DB 做不到，校验在 service（d3 §4.5），自检 SQL 见 d3 §11.2 第 4 条。
// posts 上**没有** review_state：楼层可见性跟随主题（拍板 §2.2 第 3 条），存第二份必然漂移。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_posts_floor CHECK (floor >= 1) / ck_posts_visibility / ck_posts_counts_nonneg；
//   - 部分唯一索引 uq_posts_author_client_token (author_id, client_token) WHERE client_token <> ”；
//   - fk_posts_topic → topics(CASCADE)、fk_posts_author → users(RESTRICT)、fk_posts_parent → posts(SET NULL)。
type Post struct {
	ent.Schema
}

// Mixin：public_id。
func (Post) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

func (Post) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("topic_id"),
		field.Int64("author_id"),
		field.Int64("parent_id").Optional().Nillable().Comment("楼中楼父楼层；只允许一级"),
		field.Int32("floor").Comment("1 = 主题正文；楼中楼也占 floor 号，所以 floor 不连续是正常的"),
		field.String("content_md").SchemaType(pgType("text")).Comment("原文"),
		field.String("content_html").SchemaType(pgType("text")).
			Comment("goldmark → bluemonday 的结果；列表永远不读这两列"),
		field.String("visibility").SchemaType(pgType("text")).Default("normal").
			Comment("normal/hidden/deleted，CHECK 在迁移"),
		field.String("client_token").MaxLen(64).SchemaType(pgType("varchar(64)")).Default("").
			Comment("幂等键；空串 = 不带幂等"),
		field.Int32("like_count").Default(0),
		field.Int32("dislike_count").Default(0),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：topic 侧 CASCADE、author 侧 RESTRICT、parent 侧 SET NULL（都照 DDL）。
func (Post) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("topic", Topic.Type).Field("topic_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("author", User.Type).Field("author_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("parent", Post.Type).Field("parent_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
		// 反向边（楼中楼；边本身没有新列）。
		edge.From("replies", Post.Type).Ref("parent"),
	}
}

func (Post) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("topic_id", "floor").Unique().StorageKey("uq_posts_topic_floor"),
		index.Fields("topic_id", "id").StorageKey("idx_posts_topic_id"),
		index.Fields("author_id").StorageKey("idx_posts_author"),
		index.Fields("parent_id").StorageKey("idx_posts_parent"),
	}
}
