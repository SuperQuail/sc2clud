package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Sanction 分区级限期禁言（d3-forum.md §2.1、§6.3；表 sanctions；迁移 0006_social）。权限点 user.mute。
//
// board_id = NULL 表示**全站**：拍板 §1.5 第 2 步写的是「board_id = 0 或该分区」，
// 而 0 会被外键拒绝，所以用 NULL 表达同一件事（d3 §12.1 第 10 条）。
// until = NULL 表示永久；**过期判定只在查询里**（idx_sanctions_user 的谓词里不能有 now()，
// now() 不是 IMMUTABLE，那样的索引建不出来 —— 拍板 §5.9 第 1 条）。
//
// 留给手写迁移（ent 表达不了；迁移 0006 已写）：
//   - ck_sanctions_action CHECK (action IN ('post','reply','all'))。
type Sanction struct {
	ent.Schema
}

func (Sanction) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("user_id"),
		field.Int64("board_id").Optional().Nillable().Comment("NULL = 全站；非空 = 只在该分区生效"),
		field.String("action").SchemaType(pgType("text")).Default("reply").
			Comment("post/reply/all，CHECK 在迁移。发主题查 action IN ('post','all')，回复查 IN ('reply','all')"),
		field.String("reason").MaxRuneLen(200).SchemaType(pgType("varchar(200)")).Default(""),
		field.Time("until").Optional().Nillable().Comment("NULL = 永久"),
		field.Int64("created_by").Optional().Nillable().Comment("开单人；FK users(id) ON DELETE SET NULL"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

func (Sanction) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("board", Board.Type).Field("board_id").Unique().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("creator", User.Type).Field("created_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

func (Sanction) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "until").StorageKey("idx_sanctions_user"), // 发言前判定
		index.Fields("board_id").StorageKey("idx_sanctions_board"),        // 外键路径（删分区级联）
		index.Fields("created_by").StorageKey("idx_sanctions_by"),         // 外键路径（SET NULL）
	}
}
