package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// BoardModerator 分区版主（d2-auth.md §5.9 与 d3-forum.md §2.1；表 board_moderators）。
//
// 它是 board.moderate 这个**作用域**权限的作用域来源：auth 的 Resolve 要 JOIN 它凑 Actor.BoardIDs。
// 表归 D3 读写（auth 只 SELECT），但 DDL 落在授权域迁移里（d1 §8.1 的 0003_authz）。
// 写这张表之后必须调 authSvc.InvalidateUser(ctx, userID)，否则版主上任/卸任要等缓存过期才生效。
//
// 列的两种记载在文档里不一致，本文件取 d2-auth-交接 §2.2 明确要求 auth 按它写 JOIN 的那一组：
//
//	board_id, user_id, granted_by, granted_at, expires_at
//
// （数据库设计-postgresql.md §4.1 与 d3 的旧稿只有 (board_id, user_id, created_at)，无任期信息。
//
//	差异与理由见回报，未决项已交给 Lead。）
//
// 留给手写迁移（ent 表达不了）：
//   - PRIMARY KEY (board_id, user_id)  —— ent 里退化成唯一索引，迁移落地成主键
//   - idx_board_moderators_user (user_id)
//     —— 复合主键的第二列**不算已索引**，而它是删用户/删版主任命的真实路径（拍板 §5.9 第 6 条）
//   - board_id → boards(id) ON DELETE CASCADE（这条 ALTER 在 0004_forum，boards 那时才存在）
//   - user_id  → users(id)  ON DELETE CASCADE
//   - granted_by → users(id) ON DELETE SET NULL + idx_board_moderators_granted
//   - **「未过期的版主任命」不能建部分索引**：谓词要 expires_at > now() 才成立，now() 不是 IMMUTABLE
//     （拍板 §5.9 第 1 条 / §9.10）。expires_at IS NULL = 永久任命，判定留在查询里。
//
// 与数据库文档 §2 第 12 条（每表 created_at）的偏差：本表用 granted_at 当创建时间，没有第二个 created_at
// —— 任命只有一次，granted_at 就是那一刻。已报 Lead（见回报的「不一致」清单）。
type BoardModerator struct {
	ent.Schema
}

// Fields 见 d2-auth-交接 §2.2。
func (BoardModerator) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("board_id").
			Comment("FK boards(id) ON DELETE CASCADE"),
		field.Int64("user_id").
			Comment("被任命的人；FK users(id) ON DELETE CASCADE；单列索引在迁移里"),
		field.Int64("granted_by").Optional().Nillable().
			Comment("任命人；FK users(id) ON DELETE SET NULL"),
		field.Time("granted_at").Default(time.Now).Immutable().
			Comment("任命时刻，也是这一行的 created_at（本表对外没有第二个时间列）"),
		field.Time("expires_at").Optional().Nillable().
			Comment("任期；NULL = 永久。过期判定留在查询里，不进索引谓词"),
	}
}

// Edges：board 与 user 侧 CASCADE，granted_by 侧 SET NULL。
func (BoardModerator) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("board", Board.Type).Field("board_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.To("granter", User.Type).Field("granted_by").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：复合主键（迁移落地为主键）+ 两条单列外键索引。
func (BoardModerator) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("board_id", "user_id").Unique(),
		index.Fields("user_id").StorageKey("idx_board_moderators_user"),
		index.Fields("granted_by").StorageKey("idx_board_moderators_granted"),
	}
}
