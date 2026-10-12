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

// Notification 站内通知（d4-social.md §1.1；表 notifications）。
//
// **不建 updated_at**：这张表没有「修改」语义，已读/已删是两根一次性时间轴（d4 §1.1）。
// read_at = 「看过了」，deleted_at = 「只对我隐藏」，两者语义完全分开。
//
// 留给手写迁移（ent 表达不了）：
//   - ck_notifications_type       CHECK (type IN ('reply','mention','like','reward','review','sanction','system'))
//     —— 值域 = Go 常量 notify.Kind*，逐字同名（数据库文档 §12 第 4 条自检会解析 pg_constraint）
//   - ck_notifications_link_prefix  CHECK (link = ” OR link LIKE '/%')
//   - ck_notifications_dedup_prefix CHECK (dedup_key = ” OR dedup_key ~ '^(reply|mention|like|reward|review|sanction):(post|topic|comment|issue|donation|sanction):[0-9]+$')
//   - idx_notifications_inbox  ON (user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL
//   - idx_notifications_unread ON (user_id) WHERE read_at IS NULL AND deleted_at IS NULL
//   - uq_notifications_user_dedup UNIQUE (user_id, dedup_key) WHERE dedup_key <> ”
//     —— 软删**不**解除占用（否则重试会在用户删除后复活）
type Notification struct {
	ent.Schema
}

// Mixin：public_id（DELETE /notifications/{id} 按它对地址；自增 id 不许出 API，拍板 §5.6）。
func (Notification) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d4-social.md §1.1。
func (Notification) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("user_id").Comment("收件人"),
		field.Int64("actor_id").Optional().Nillable().Comment("触发者；系统通知为 NULL"),
		field.String("type").MaxLen(16).Comment("reply/mention/like/reward/review/sanction/system，CHECK 在手写迁移"),
		field.JSON("payload", map[string]any{}).Default(map[string]any{}).
			Comment("只放渲染这一条所需的最小形状：{ref_type,ref_id,topic_id,state,text}；不放快照"),
		field.String("link").Default("").Comment("点击跳转，必须站内（以 / 开头）"),
		field.String("dedup_key").Default("").Comment("ref_type:ref_id，由 notify.RefKey 一个函数生成"),
		field.Time("read_at").Optional().Nillable(),
		field.Time("deleted_at").Optional().Nillable().Comment("软删：只对自己隐藏；90 天后由 cron 硬删"),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges 只服务后台一次性加载；列表查询走原生 SQL（d4 §4.1）。
func (Notification) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("user", User.Type).Field("user_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Cascade)),
		edge.From("actor", User.Type).Ref("acted_notifications").Field("actor_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
	}
}

// Indexes：两条部分索引 + 外键索引（actor_id 不在任何索引前导位，PG 不自动建）。
// 部分索引与唯一索引的谓词只在手写迁移里生效；这里写 IndexWhere 是让两边读起来一致（d4 §2.1）。
func (Notification) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("user_id", "created_at", "id").
			Annotations(entsql.IndexWhere("deleted_at IS NULL")),
		index.Fields("user_id").
			Annotations(entsql.IndexWhere("read_at IS NULL AND deleted_at IS NULL")),
		index.Fields("user_id", "dedup_key").Unique().
			Annotations(entsql.IndexWhere("dedup_key <> ''")),
		index.Fields("actor_id"),
	}
}
