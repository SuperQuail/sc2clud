package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// BoardACL 分区 × 角色的发言四象限（d3-forum.md §2.1；表 board_acls）。
// 判定顺序见拍板 §1.5，落地在 forum 的 canSpeak（d3 §6.2）。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_board_acls_no_contradiction CHECK (NOT (deny_post AND can_post) AND NOT (deny_reply AND can_reply))
//     —— 它让「禁止优先」在表结构上就成立：第 4 步与第 5 步永远只有一个会命中；
//   - 主键 (board_id, role_id)：ent 的表都带 id 列，所以自然键写成唯一索引（见回报「与设计不一致」）。
//
// **表名必须显式声明**（2026-10-13 数据库审计 D2）：ent 的 inflect 不认识全大写 ACL，
// 默认会把 BoardACL 复数化成 board_ac_ls；加 entsql.Table 之后才是 board_acls。
// 不写它，client.Schema.Create 会去建一张**错误的表**并让测试变绿，而生产库读的是 board_acls。
func (BoardACL) Annotations() []*entsql.Annotation {
	return []*entsql.Annotation{entsql.Table("board_acls")}
}

type BoardACL struct {
	ent.Schema
}

func (BoardACL) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("board_id"),
		field.Int64("role_id"),
		field.Bool("can_post").Default(false),
		field.Bool("can_reply").Default(false),
		field.Bool("deny_post").Default(false),
		field.Bool("deny_reply").Default(false),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：两侧都 CASCADE（纯关联表）。
func (BoardACL) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("board", Board.Type).Field("board_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("role", Role.Type).Field("role_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
	}
}

func (BoardACL) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("board_id", "role_id").Unique(),
		index.Fields("role_id").StorageKey("idx_board_acls_role"), // role_id 的外键路径（删角色）
	}
}
