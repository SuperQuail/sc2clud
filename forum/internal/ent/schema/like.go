package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Like 赞/踩，**一张表四种目标**（d3-forum.md §2.1/§2.2、§5.1–§5.3；表 likes）。
//
// target_id 是**多态**的（topic / post / issue / issue_comment），PG 无法对它建外键：
// 孤儿行由「删目标时同事务清理 likes」+ d3 §11.2 第 1 条的孤儿检查兜（拍板 §5.9 第 5 条）。
// target_type='issue' 现在没有任何写路径（d3 §5.2 表格），CHECK 里留着它是为了以后加字段时不改约束。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_likes_target_type CHECK (target_type IN ('topic','post','issue','issue_comment'))；
//   - ck_likes_value CHECK (value IN (1, -1))；
//   - 「主题只有赞没有踩」在 CHECK 里做不到（要带子查询），落点是 service + d3 §11.2 第 5 条自检。
type Like struct {
	ent.Schema
}

func (Like) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("user_id"),
		field.String("target_type").SchemaType(pgType("text")).
			Comment("topic/post/issue/issue_comment，CHECK 在迁移"),
		field.Int64("target_id").Comment("多态，无外键（见文件头）"),
		field.Int16("value").Comment("1 = 赞，-1 = 踩；same-value 重提不改计数（CAS，d3 §5.1）"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (Like) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

func (Like) Indexes() []ent.Index {
	return []ent.Index{
		// 唯一约束即索引：投票幂等 + 取 my_vote。
		index.Fields("user_id", "target_type", "target_id").Unique().StorageKey("uq_likes_user_target"),
		// 多态表没有外键，target_id 上的索引必须自己建（计数、批量取我的票、孤儿自检）。
		index.Fields("target_type", "target_id").StorageKey("idx_likes_target"),
	}
}
