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

// User 账号主表（d2-auth.md §5.1；表 users）。
//
// 不嵌 mixin.Time 而手写两个时间列：迁移里的 DDL 是 DEFAULT now()（数据库文档 §2 第 12 条），
// 只有 entsql.DefaultExpr 能把默认值写进 DDL；其余 schema 文件同一写法。
//
// 留给手写迁移（ent 表达不了）：
//   - uq_users_username_lower  UNIQUE (lower(username))  —— 表达式唯一索引（数据库文档 §2 第 9 条）
//   - uq_users_email_lower     UNIQUE (lower(email))
//   - idx_users_nickname_lower (lower(nickname))         —— d4 §4.14 昵称前缀搜索 + dup 子查询（拍板 U4）
//   - ck_users_status             CHECK (status IN ('active','banned','deleted'))
//     （不再有 activation_pending：模式由 site_settings 的 auth.registration.auto_activate 决定，
//     它是**全局配置**不是每用户状态 —— 拍板 §12.2）
//   - ck_users_exp_nonneg         CHECK (exp >= 0)
//   - ck_users_level_min          CHECK (level >= 1)
//   - fk_users_role            FK (role_id)           → roles(id)  ON DELETE RESTRICT
//   - fk_users_avatar          FK (avatar_hash)       → images(hash) ON DELETE SET NULL
//   - fk_users_avatar_small    FK (avatar_small_hash) → images(hash) ON DELETE SET NULL
//   - fk_users_default_avatar  FK (default_avatar_hash) → images(hash) ON DELETE SET NULL
//   - fk_users_equipped_title  FK (equipped_title_id) → titles(id) ON DELETE SET NULL
//   - 五条纯外键索引 idx_users_role / idx_users_avatar / idx_users_avatar_small /
//     idx_users_default_avatar / idx_users_equipped_title（数据库文档 §12 第 1 条的自检没有排除名单，不加就红）
//
// 头像三列是 char(64)，images.hash 也是 char(64)（0002_accounts 建表时按 char(64) 落地）。
type User struct {
	ent.Schema
}

// Mixin：public_id（对外唯一 ID，应用生成 UUID v7，DB 不设默认值，拍板 §5.6）。
func (User) Mixin() []ent.Mixin {
	return []ent.Mixin{mixin.PublicID{}}
}

// Fields 见 d2-auth.md §5.1，逐列对齐。
func (User) Fields() []ent.Field {
	return []ent.Field{
		field.Int64("id"),
		field.Int64("role_id").
			Comment("基线角色（单一，拍板 §1.4）；FK roles(id) ON DELETE RESTRICT 在迁移里"),
		field.String("username").MaxLen(32).Immutable().
			Comment("登录名，建后不可改；大小写不敏感唯一靠 uq_users_username_lower"),
		field.String("email").MaxLen(254).
			Comment("大小写不敏感唯一靠 uq_users_email_lower"),
		field.String("password_hash").
			Comment("argon2id PHC 串（D2 §7.3）"),
		field.String("nickname").MaxLen(20).
			Comment("显示名，非空、允许重名"),
		field.String("bio").MaxLen(200).Default(""),
		field.String("avatar_hash").MaxLen(64).Optional().Nillable().
			Comment("sha256 hex；FK images(hash) ON DELETE SET NULL"),
		field.String("avatar_small_hash").MaxLen(64).Optional().Nillable().
			Comment("列表页缩略图；空则回落原图；FK images(hash) ON DELETE SET NULL"),
		field.String("default_avatar_hash").MaxLen(64).Optional().Nillable().
			Comment("默认头像池里分到的那张，注册时写一次、永不重算（拍板 §8.8 / U12）；FK images(hash) ON DELETE SET NULL。\n列本身由 0010_media 的 ALTER 加（0010_media.up.sql），不是 0002 建表的一部分"),
		field.String("status").MaxLen(8).Default("active").
			Comment("封禁轴：active/banned/deleted，CHECK 在迁移"),
		field.Time("email_verified_at").Optional().Nillable().
			Comment("邮箱验证轴；NULL = 未验证，不影响任何权限（拍板 §9.12）"),
		field.Time("activated_at").Optional().Nillable().
			Comment("激活轴；NULL = 未激活：可登录可读，写操作 403 auth.not_activated（拍板 §9.4）"),
		field.Bool("trusted").Default(false).
			Comment("true = 发帖跳过人工审核"),
		field.Int64("equipped_title_id").Optional().Nillable().
			Comment("佩戴中的头衔（只有一个）；FK titles(id) ON DELETE SET NULL"),
		field.Int("exp").Default(0).
			Comment("经验；CHECK (exp >= 0) 在迁移（不用 .NonNegative()，那会在 ent 侧再生成一条 CHECK）"),
		field.Int("level").Default(1).
			Comment("等级；CHECK (level >= 1) 在迁移；不变量 level = floor(sqrt(exp/100)) + 1 由 D4 同事务维护"),
		field.Time("last_login_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now).Immutable().
			Annotations(entsql.DefaultExpr("now()")),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now).
			Annotations(entsql.DefaultExpr("now()")),
	}
}

// Edges：全部 OnDelete 都照 DDL 写；不写会被 ent 生成出与迁移不同的外键动作。
// 反向边（images / notifications / messages_* …）由别的域的文件 .Ref() 指过来，这里必须给出同名边。
func (User) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("role", Role.Type).Field("role_id").Unique().Required().
			Annotations(entsql.OnDelete(entsql.Restrict)),
		edge.To("equipped_title", Title.Type).Field("equipped_title_id").Unique().
			Annotations(entsql.OnDelete(entsql.SetNull)),
		// 以下十六条是别人 .Ref() 过来的反向边，边本身没有新列。
		// 名字必须与对方 .Ref("...") 的参数逐字相同，否则 entc 报
		// 「edge "x" is missing for inverse edge」——别人改 schema 时先看这里。
		edge.To("images", Image.Type),
		edge.To("payment_channels", PaymentChannel.Type),
		edge.To("notifications", Notification.Type),
		edge.To("acted_notifications", Notification.Type),
		edge.To("notification_mutes", NotificationMute.Type),
		edge.To("messages_as_low", Message.Type),
		edge.To("messages_as_high", Message.Type),
		edge.To("messages_sent", Message.Type),
		edge.To("donations_sent", DonationRecord.Type),
		edge.To("donations_received", DonationRecord.Type),
		edge.To("donations_verified", DonationRecord.Type),
		edge.To("exp_events", ExpEvent.Type),
		edge.To("user_titles", UserTitle.Type),
		edge.To("granted_titles", UserTitle.Type),
		edge.To("announcements", Announcement.Type),
		edge.To("banners", Banner.Type),
	}
}

// Indexes：只声明真实列上的 (created_at, id)，服务后台用户列表游标（拍板 §5.1 第 4 条：列序与排序键同序）。
// 表达式索引与五条外键索引都只在迁移里（见文件头）。
func (User) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("created_at", "id").StorageKey("idx_users_created_at"),
	}
}
