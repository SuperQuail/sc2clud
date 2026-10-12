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

// Topic 主题（d3-forum.md §2.1/§2.2；表 topics；迁移 0004_forum）。本域最重要的表。
//
// **三条互相独立的轴，禁止合并**（拍板 §2.2；d3 §12.1 第 1 条）：
//
//	visibility   公开轴：normal / hidden / deleted
//	review_state 审核轴：pending / approved / rejected
//	locked_at    锁定轴：非空 = 不能再回复（锁定不是可见性）
//
// 「pending + normal」「approved + deleted」都是合法组合，不是矛盾。
// last_reply_at NOT NULL：建主题 = 1 楼 created_at，「没有回复」不是一个状态（d3 §0 结论 1）。
//
// 留给手写迁移（ent 表达不了；迁移 0004 已写）：
//   - 7 条 CHECK：kind / visibility / review_state / resource_status / resource_status_kind /
//     counts_nonneg / deleted_no_pin；
//   - 6 条部分索引（谓词只引用列，时间比较一律留在查询里，拍板 §5.9 第 1 条）：
//     idx_topics_recent、idx_topics_board_live、idx_topics_board_new、idx_topics_kind_new、
//     idx_topics_featured、idx_topics_pinned、idx_topics_review_queue；
//   - 部分唯一索引 uq_topics_author_client_token (author_id, client_token) WHERE client_token <> ”。
type Topic struct {
	ent.Schema
}

// Mixin：public_id（API 只出现它，拍板 §5.6）。
func (Topic) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d3-forum.md §2.1/§2.2，逐列对齐。
func (Topic) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("board_id"),
		field.Int64("author_id"),
		field.String("kind").SchemaType(pgType("text")).Default("discussion").
			Comment("discussion/resource/repost，CHECK 在迁移。只有 resource 能挂 topic_sources 与非空 resource_status"),
		field.String("title").MaxLen(200).SchemaType(pgType("varchar(200)")),
		field.String("excerpt").MaxLen(200).SchemaType(pgType("varchar(200)")).Default("").
			Comment("列表卡片摘要，写入时由 1 楼正文派生。有它列表才不用读 posts 的大字段正文"),
		field.String("visibility").SchemaType(pgType("text")).Default("normal").
			Comment("公开轴：normal/hidden/deleted，CHECK 在迁移"),
		field.String("review_state").SchemaType(pgType("text")).Default("approved").
			Comment("审核轴：pending/approved/rejected。pending/rejected 只有作者本人与持 post.review 的人可见"),
		field.String("review_note").MaxLen(500).SchemaType(pgType("varchar(500)")).Optional().Nillable().
			Comment("「请求修改」给作者看的话；request_revision 时必填（service 判）"),
		field.Int64("reviewed_by").Optional().Nillable().Comment("审核人；FK users(id) ON DELETE SET NULL"),
		field.Time("reviewed_at").Optional().Nillable(),
		field.Time("locked_at").Optional().Nillable().Comment("非空 = 锁定"),
		field.Time("pinned_at").Optional().Nillable().Comment("非空 = 置顶；时间戳既当开关又当时间"),
		field.Time("featured_at").Optional().Nillable().Comment("非空 = 精华"),
		field.String("resource_status").SchemaType(pgType("text")).Optional().Nillable().
			Comment("maintained/bugfix_only/unmaintained，仅 kind=resource。与 topic_sources.upkeep 回答的是两个问题"),
		field.String("client_token").MaxLen(64).SchemaType(pgType("varchar(64)")).Default("").
			Comment("幂等键；空串 = 不带幂等（部分唯一索引只在非空时生效）"),
		field.Int32("reply_count").Default(0).Comment("含楼中楼；发/删回复时同事务重算，不做增量"),
		field.Int32("like_count").Default(0).Comment("只统计 value=1，主题没有踩（拍板 §3）"),
		field.Int64("view_count").Default(0).Comment("走 counter 缓冲批量写回，不在请求里 UPDATE"),
		field.Time("last_reply_at").
			Comment("排序键，NOT NULL：建主题 = 1 楼 created_at，加回复 = 该回复时间，删回复 = 剩余最新"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：三条 FK 的删除动作都照迁移 0004 写。
func (Topic) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("board", Board.Type).Field("board_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("author", User.Type).Field("author_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("reviewer", User.Type).Field("reviewed_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
		// 反向边：donation_record.post 的 .Ref("donations") 指过来（D6 的赞赏挂帖子）。
		edge.To("donations", DonationRecord.Type),
	}
}

// Indexes：只声明真实列上的普通索引；6 条部分索引与部分唯一索引都在迁移里（见文件头）。
func (Topic) Indexes() []ent.Index {
	return []ent.Index{
		// 个人主页固定按 created_at 排。**不能是部分索引**：作者要看见自己的 pending/rejected。
		index.Fields("author_id", "created_at", "id").
			Annotations(entsql.DescColumns("created_at", "id")).
			StorageKey("idx_topics_author"),
		// 下面两条**不是给查询用的**，是外键检查要的（带谓词的索引服务不了引用完整性查找）。
		index.Fields("board_id").StorageKey("idx_topics_board_id"),
		index.Fields("reviewed_by").StorageKey("idx_topics_reviewed_by"),
	}
}
