# 数据库设计（PostgreSQL）

> 本文档取代 `论坛后端技术方案-v2.md` 第 6 章（原 SQLite + ent）、第 7.6 章（FTS5 搜索）、第 16 章（VACUUM INTO 备份）、第 18 章（以后切 PG）。
> 决策已定：**数据库用 PostgreSQL**（原方案 D1 的 A 选项作废），**整个表结构重新设计**，**旧站只迁移用户**，且 users 表也是全新设计（不是列复制）。
> 规则同其它文档：**必须 / 禁止** 是硬要求；不确定就停下来问。

---

## 1. 从 SQLite 换到 PostgreSQL（已完成的切换）

原 v2 第 6 章（SQLite + 读写双池 + FTS5 + VACUUM INTO）**整章作废**，按本文件重写。换掉的实质只有五处：**类型变真**（timestamptz / boolean / jsonb / date / inet / bytea / uuid）、**单池取代读写双池**、**`lower(col)` 表达式索引取代 `*_normalized` 列**、**`FOR UPDATE SKIP LOCKED` 取代两步领任务**、**tsvector 生成列取代 FTS5**。
**依赖变化**：Go 侧删 `modernc.org/sqlite`，加 `github.com/jackc/pgx/v5`；ent 开 `sql/lock`。
**不要**按已作废的章节写代码——那是把决定扔掉的东西再实现一遍。

## 2. 全局约定（违反即评审打回）

1. **表名**：复数、snake_case（`users`、`donation_records`）。**列名**：snake_case。索引 `idx_<表>_<列…>`，唯一索引 `uq_<表>_<列…>`，检查约束 `ck_<表>_<语义>`，外键 `fk_<表>_<列>`。
2. **主键**：`id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`。**禁止 `serial`/`bigserial`**（identity 才是标准，且不会留下孤儿 sequence 权限问题）。
3. **对外 ID**：`public_id uuid NOT NULL UNIQUE`，值由**应用**用 UUID v7 生成（`uuid.NewV7()`），**不设数据库默认值**——不依赖 PG 版本是否自带 `uuidv7()`。URL 与 API 只出现 public_id，**禁止把自增 id 返回给前端**。
4. **时间**：一律 `timestamptz`，列名以 `_at` 结尾，默认 `now()`，语义永远是 UTC。**禁止 `timestamp without time zone`**（它会静默丢掉时区，是跨时区事故的标准配方）。业务代码取当前时间仍走注入的 `clock.Clock`。
5. **金额**：`bigint`，单位分，列名以 `_cents` 结尾。**禁止 `money`、禁止 float**。
6. **枚举**：列类型 `text` + `CHECK (col IN (...))`。**已核实：ent 的 `field.Enum` 在 PG 上只生成 varchar、不生成 CHECK**（`ent/schema/postgres.go:141-144`），所以 CHECK 必须写进手写迁移，并由第 12 章的自检比对「CHECK 值域 ↔ Go 常量」。**禁止 PG 原生 enum 类型**：`ALTER TYPE ... ADD VALUE` 只能加不能删、不能重排、不能在事务里回滚，和 ent/Atlas 的迁移流程配合时极易卡住；值域的唯一真源是 Go 常量 + 迁移里的 CHECK，两处必须同名（启动自检见第 12 章）。
7. **布尔**：`boolean NOT NULL DEFAULT false`。禁止用 0/1。
8. **JSON 一律 `jsonb`**。禁止 `json`（无索引、无去重）、禁止把结构化数据塞 TEXT。
9. **大小写不敏感的唯一性**（已核实：ent 的 Index 只能引用真实列，**声明不了表达式索引**，所以 `lower()` 唯一索引写在手写迁移里，并注意 Atlas diff 会想 DROP 它）：用**表达式唯一索引** `CREATE UNIQUE INDEX ... ON t (lower(col))`，**不再存 `*_normalized` 列**。查询必须写成 `lower(col) = lower($1)`，与索引表达式逐字一致才走索引。
10. **外键必须显式建索引**。PG **不会**为外键自动建索引（这点和 MySQL 不同），漏了会在删父行时全表扫。第 12 章有可执行的检查 SQL 把这件事钉死。
11. **删除策略**：
    - `users` **永不硬删**（封禁/注销都是 `status`），所有引用 users 的外键用 `RESTRICT` 或 `SET NULL`；
    - 内容（topics/posts）**软删**（`status`），不物理删除；
    - 纯关联表（likes、bookmarks、topic_images…）用 `ON DELETE CASCADE`。
12. **每张表都有 `created_at`**；会变的表加 `updated_at`。两者由 **ent mixin 在应用层写**，**不建触发器**。若确实需要 DDL 默认值（如 `now()`），必须用 `entsql.DefaultExpr("now()")` —— **已核实：ent 的 `.Default(time.Now)` / `.Default(uuid.New)` 不会写进 DDL**。
13. **有业务上限的文本用 `varchar(n)`**（PG 里 varchar(n) 没有性能劣势），长度约束留在库里；无上限的（正文、HTML）用 `text`。
14. **禁止**：`serial`、`timestamp`（无时区）、PG 原生 enum、`money`、float 存金额、用 TEXT 存 UUID、用 `SELECT ... FOR UPDATE` 而不带 `SKIP LOCKED` 去抢队列、在应用里拼 SQL 字符串、物理删除内容行。
15. **部分索引（partial index）是本设计的常规武器**（PG 特性，SQLite 那版用不上）：只索引「活」的行，例如未读通知、未完成任务、有效横幅。

---

## 3. 表清单总表（45 张业务表 + 2 张辅助表：topic_search、import_map）

| 域 | 表 | 用途 | 关键索引（除主键） |
|---|---|---|---|
| 账号 | users | 用户 | `lower(username)`、`lower(email)` 唯一 |
| 账号 | sessions | 登录会话 | `token_hash` 唯一、`user_id`、`expires_at` |
| 账号 | email_tokens | 邮箱验证 / 找回密码 | `token_hash` 唯一、`user_id`、`expires_at` |
| 授权 | roles / permissions / role_permissions（**角色在 users.role_id 上，单一**） | RBAC | 见 §4.1 |
| 授权 | board_moderators | 分区版主 | `(board_id, user_id)` 主键 |
| 授权 | audit_logs | 审计 | `(actor_id, created_at DESC)`、`(target_type, target_id)` |
| 论坛 | boards | 版块 | `slug` 唯一、`sort` |
| 论坛 | board_acls | 分区发言 ACL（D6） | `(board_id, role_id)` 主键 |
| 论坛 | topics | 主题 | 见 §4.2 |
| 论坛 | posts | 楼层（1 楼 = 主题正文） | `(topic_id, floor)` 唯一、`parent_id` |
| 论坛 | topic_sources | 资源帖下载源 | `(topic_id, sort)` |
| 论坛 | topic_images | 帖子配图 | 主键 `(topic_id, image_hash)` |
| 社交 | likes | 赞/踩（多态） | `(user_id, target_type, target_id)` 唯一 |
| 社交 | bookmarks | 收藏 | 主键 `(user_id, topic_id)` |
| 社交 | blocks | 拉黑 | 主键 `(user_id, target_user_id)` |
| 社交 | reports | 举报 | `(status, created_at DESC)` |
| 社交 | sanctions | 禁言 | `(user_id, until)` |
| 通知 | notifications | 站内通知 | 两个部分索引，见 §4.5 |
| 通知 | notification_mutes | 不再通知 | 主键 `(user_id, kind, target_key)` |
| 媒体 | images | 内容寻址图片 | `refcount`（GC 用） |
| 媒体 | default_avatars | 默认头像池 | — |
| 媒体 | payment_channels | 收款码 | `(user_id, sort)` |
| 赞赏 | donation_records | 打赏申报单（人工核验，站点不经手资金） | `(state, created_at DESC)`、`(recipient_id, state, …)` |
| 赞赏 | user_donation_settings / donation_notice_defaults | 打赏展示开关与提示文案 | 主键 `user_id` / `channel` |
| 下载 | releases / release_assets | 启动器索引（不存字节） | `version` 唯一、`(release_id, platform, arch)` 唯一 |
| 邮件 | mail_accounts | 发信账号（凭据加密） | `name` 唯一 |
| 邮件 | mail_quota | 每日额度账 | 主键 `(account_id, day)` |
| 邮件 | mail_logs | 每封邮件一条 | `idempotency_key` 唯一 |
| 站点 | site_settings / site_domains | 键值配置 / 域名白名单 | 各自的 key 主键 |
| 站点 | announcements / banners / banner_dismissals | 公告 / 横幅 | `(enabled, starts_at, ends_at)` |
| 社交 | messages | 一对一私信 | `(low_id, high_id, id DESC)` + 两个未读部分索引 |
| 社交 | titles / user_titles | 头衔目录与持有关系 | `key` 唯一、主键 `(user_id, title_id)` |
| 社交 | exp_events | 经验流水 | `(user_id, created_at DESC)` |
| 论坛 | post_issues / issue_comments | 资源帖问题与建议 | `(topic_id, status, created_at DESC)` |
| 任务 | jobs | 任务队列 | 部分唯一索引 + `(status, run_at, priority)` |

---

## 4. 分域详细设计

类型简写：`ts` = timestamptz，`fk` = 外键。所有表默认带 `created_at ts NOT NULL DEFAULT now()`（下表中不再重复列出，只在需要时写 `updated_at`）。

### 4.1 账号与授权

**users** —— 全新设计，不是旧表复制

| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | 内部主键 |
| public_id | uuid | NOT NULL UNIQUE | 应用生成 v7 |
| username | varchar(32) | NOT NULL | 登录名（ASCII），**唯一性走 `lower(username)` 表达式索引** |
| email | varchar(254) | NOT NULL | 同上看 `lower(email)` |
| password_hash | text | NOT NULL | argon2id，格式见后端方案 §9.1 |
| nickname | varchar(20) | NOT NULL | 显示名 |
| avatar_hash | char(64) | NULL → fk images(hash) ON DELETE SET NULL | 内容寻址 |
| avatar_small_hash | char(64) | NULL → fk images(hash) ON DELETE SET NULL | 列表页省带宽；空则回落原图 |
| bio | varchar(200) | NOT NULL DEFAULT '' | — |
| status | text | NOT NULL DEFAULT 'active'，ck ('active','banned','deleted') | 封禁轴：banned 立即失效（v2 §9.2 决策 2） |
| email_verified_at | ts | NULL | 邮箱验证轴：NULL = 未验证。**v2 §9.1 要求验证后才能登录** |
| activated_at | ts | NULL | **激活轴（独立于上面两根）**：NULL = 未激活，可登录但不可发帖/回复/上传。旧站 policy `registration.require_activation` 的落点 |
| trusted | boolean | NOT NULL DEFAULT false | true = 发帖跳过人工审核（旧站同名语义，见 §4.2 审核状态） |
| last_login_at | ts | NULL | — |
| updated_at | ts | NOT NULL DEFAULT now() | — |

索引：`uq_users_username_lower (lower(username))`、`uq_users_email_lower (lower(email))`、`idx_users_created_at (created_at DESC)`（后台列表）。
**三根状态轴必须分开判**（旧站也是两根独立轴：`activated_at` 管「能不能写」，另用 `email_codes` 管邮箱验证——调查已在 `旧站用户表提取.md` 证实）：

    status = 'banned'      → 该用户全部会话立即失效（401）
    email_verified_at IS NULL → 不能登录（v2 §9.1）
    activated_at IS NULL   → 能登录，写操作 403 auth.not_activated

三处判定只在认证中间件与 `authz` 里各写一次，**禁止业务模块各判各的**。

其它不变量：`username` **不可改**（旧站语义：登录标识注册后固定）；`nickname` 非空但**允许重复**（旧站 `display_name` 同语义）；旧站引导账号的邮箱是占位值 `{handle}@localhost`，导入时合成 `<username>@import.invalid` 并保持未验证（§10.2）。

**明确不继承旧表的**：等级/经验、磁盘配额、角色枚举列、头衔外键、`avatar_mime`、`used_bytes`、死列 `disabled_at`、遗留列 `post_ban_until`——理由见 §11。

**sessions**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| token_hash | bytea | NOT NULL UNIQUE | 只存 token 的 SHA-256（32 字节） |
| user_id | bigint | NOT NULL fk users ON DELETE CASCADE | — |
| csrf_token | varchar(64) | NOT NULL | 随 Principal 下发 |
| ip | inet | NOT NULL | PG 原生类型 |
| user_agent | text | NOT NULL DEFAULT '' | — |
| expires_at | ts | NOT NULL | — |
| last_seen_at | ts | NOT NULL DEFAULT now() | 批量刷写（后端方案 §9.2 决策 3） |

索引：`idx_sessions_user_id`、`idx_sessions_expires_at`（过期清理）。

**email_tokens**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| user_id | bigint | NOT NULL fk users CASCADE | — |
| token_hash | bytea | NOT NULL UNIQUE | 同上，不存明文 |
| purpose | text | ck in ('verify','reset') | — |
| expires_at | ts | NOT NULL | — |
| used_at | ts | NULL | 一次性消费 |

**roles**：`id`、`key varchar(32)` UNIQUE、`name varchar(32)`、`description varchar(200)`、`is_system boolean NOT NULL DEFAULT false`、`priority int NOT NULL DEFAULT 0`（**只用于后台展示排序，禁止用于授权判断**）。
**permissions**：`id`、`key varchar(64)` UNIQUE、`grp varchar(32)` NOT NULL、`description varchar(200)`。权限点由**迁移**写入，与 `internal/authz/permissions.go` 的常量一一对应。
**role_permissions**：`role_id`、`permission_id`，主键 `(role_id, permission_id)`，两侧 CASCADE。
**users.role_id**：`bigint NOT NULL fk roles RESTRICT` —— **一个用户只有一个角色**。

> **权限树的完整设计见 `RBAC权限树设计.md`（唯一真源）**。修正（2026-10-12）：原设计用 `user_roles` 关系表（抄 RBAC 的 N:N 惯性），但本产品的权限树是**层级**——
> 超级管理员 / 管理员 / 认证创作者 / 普通用户，一个人只站在一个节点上。
> 于是取消 `user_roles` 关系表，改为 `users.role_id` 单列外键；权限仍由 `role_permissions` 决定。
> 迁移也因此简化：旧站的「角色列」直接映射成一个 role_id，不需要展开成关系。
**board_moderators**：`board_id`、`user_id`，主键 `(board_id, user_id)`，两侧 CASCADE。

**audit_logs**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| actor_id | bigint | NULL fk users ON DELETE SET NULL | 操作者 |
| action | varchar(64) | NOT NULL | 如 `role.grant` |
| target_type | varchar(32) | NOT NULL | user / role / board / mail_account |
| target_id | varchar(64) | NOT NULL | 存 public_id 或 key，字符串存 |
| detail | jsonb | NOT NULL DEFAULT '{}' | 变更前后 |
| ip | inet | NULL | — |

索引：`idx_audit_logs_actor (actor_id, created_at DESC)`、`idx_audit_logs_target (target_type, target_id)`、`idx_audit_logs_created (created_at DESC)`。

### 4.2 论坛

**boards**：`id`、`slug varchar(32)` UNIQUE、`name varchar(32)`、`description varchar(200) DEFAULT ''`、`sort int NOT NULL DEFAULT 0`、`status text ck ('active','archived')`、`cover_hash char(64) NULL fk images SET NULL`、`acl_enabled boolean NOT NULL DEFAULT false`、`updated_at`。
索引：`idx_boards_sort (sort)`。**表驱动**：新增分区零代码改动（旧站把它写成枚举 + 静默丢弃未知 key，是本项目最典型的历史坑）。

**board_acls**（D6 的落点）：`board_id`、`role_id`、`can_post bool`、`can_reply bool`、`deny_post bool DEFAULT false`、`deny_reply bool DEFAULT false`，主键 `(board_id, role_id)`，CASCADE。判定顺序（service 层）：超管 → 禁言 → `board.acl_enabled=false` 放行 → **任一角色 deny 则拒绝** → 任一角色 can 则放行 → 都没命中则拒绝。

**topics**

| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| public_id | uuid | NOT NULL UNIQUE | — |
| board_id | bigint | NOT NULL fk boards ON DELETE RESTRICT | — |
| author_id | bigint | NOT NULL fk users ON DELETE RESTRICT | — |
| kind | text | ck ('discussion','resource','repost') | 帖子三类 |
| title | varchar(200) | NOT NULL | — |
| status | text | DEFAULT 'normal'，ck ('normal','locked','hidden','deleted','pending','rejected') | 软删 + 审核：`pending`/`rejected` 只有作者与管理员可见；作者 `trusted=true` 直接发布（旧站 review.rs 语义） |
| resource_status | text | NULL，ck ('maintained','bugfix_only','unmaintained') | 仅 kind=resource |
| pinned_at | ts | NULL | 置顶 |
| featured_at | ts | NULL | 精华 |
| reply_count | int | NOT NULL DEFAULT 0 | 计数列，与 posts 同事务维护 |
| like_count | int | NOT NULL DEFAULT 0 | — |
| view_count | bigint | NOT NULL DEFAULT 0 | 由 counter 缓冲批量写回 |
| last_reply_at | ts | NULL | 列表排序键 |
| updated_at | ts | NOT NULL DEFAULT now() | — |

索引：
- `idx_topics_board_list (board_id, pinned_at DESC NULLS LAST, last_reply_at DESC NULLS LAST)` —— 分区列表（置顶优先，其余按最后回复）
- `idx_topics_home_list (pinned_at DESC NULLS LAST, last_reply_at DESC NULLS LAST)` —— 首页
- `idx_topics_author (author_id, created_at DESC)` —— 个人主页
- `idx_topics_board_kind (board_id, kind, created_at DESC)` —— 按类型筛选
- 检查：`ck_topics_resource_status (kind = 'resource' OR resource_status IS NULL)`

**posts**

| 列 | 类型 | 约束 / 默认 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| public_id | uuid | NOT NULL UNIQUE | — |
| topic_id | bigint | NOT NULL fk topics ON DELETE CASCADE | — |
| author_id | bigint | NOT NULL fk users ON DELETE RESTRICT | — |
| parent_id | bigint | NULL fk posts ON DELETE SET NULL | **只允许一级**（父必须是普通回复），service 层校验 |
| floor | int | NOT NULL | 1 = 主题正文 |
| content_md | text | NOT NULL | 原文 |
| content_html | text | NOT NULL | goldmark + bluemonday 清洗后的结果 |
| status | text | DEFAULT 'normal'，ck ('normal','deleted','hidden') | — |
| like_count | int | NOT NULL DEFAULT 0 | — |
| dislike_count | int | NOT NULL DEFAULT 0 | — |
| updated_at | ts | NOT NULL DEFAULT now() | — |

索引：`uq_posts_topic_floor (topic_id, floor)`、`idx_posts_topic_id (topic_id, id)`（游标分页）、`idx_posts_author (author_id)`、`idx_posts_parent (parent_id)`（外键索引，PG 不自动建）。
检查：`ck_posts_floor_positive (floor >= 1)`。

**topic_images**：`topic_id`、`image_hash char(64) fk images RESTRICT`、`sort int`，主键 `(topic_id, image_hash)`，topic 侧 CASCADE。
**topic_sources**：`id`、`topic_id fk CASCADE`、`label varchar(32)`、`url text`、`code varchar(16) NULL`（提取码）、`sort int`。索引 `idx_topic_sources_topic (topic_id, sort)`。

### 4.3 社交

**likes**（赞与踩同一张表）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| user_id | bigint | NOT NULL fk users CASCADE | — |
| target_type | text | ck ('topic','post') | — |
| target_id | bigint | NOT NULL | **多态，无外键**，见下方说明 |
| value | smallint | NOT NULL，ck (value in (1, -1)) | 1 = 赞，-1 = 踩 |
| created_at | ts | NOT NULL DEFAULT now() | — |

索引：`uq_likes_target (user_id, target_type, target_id)`、`idx_likes_target (target_type, target_id)`（计数与列表回显）。

> **多态外键的取舍（明确记账）**：`target_id` 指向 topics 或 posts，**PG 无法对它建外键**。代价是「删主题后遗留的 like 行」需要应用保证：删除/隐藏目标时在同一事务里清理对应 likes。替代方案是拆成 `topic_likes` / `post_likes` 两张表拿到真外键，但那会把「切换赞」的规则写成两遍——正是复盘里「同一概念多份实现」的根因。**选择：保留多态 + service 层事务保证 + 第 12 章加一条孤儿检查 SQL。**

**bookmarks**：`user_id`、`topic_id`、`created_at`，主键 `(user_id, topic_id)`，两侧 CASCADE。索引 `idx_bookmarks_user (user_id, created_at DESC)`。

**blocks**：`user_id`、`target_user_id`、`created_at`，主键 `(user_id, target_user_id)`，两侧 CASCADE，检查 `ck_blocks_not_self (user_id <> target_user_id)`。索引 `idx_blocks_target (target_user_id)`。

**reports**：`id`、`target_type text ck ('topic','post','user')`、`target_id bigint`、`reporter_id bigint NULL fk users SET NULL`、`reason varchar(500)`、`status text ck ('open','handled','dismissed')`、`handled_by bigint NULL fk users SET NULL`、`handled_at ts NULL`。索引 `idx_reports_status (status, created_at DESC)`、`idx_reports_target (target_type, target_id)`。

**sanctions**：`id`、`user_id fk CASCADE`、`board_id bigint NULL fk boards CASCADE`（NULL = 全局）、`action text ck ('post','reply')`、`reason varchar(200)`、`until ts NULL`（NULL = 永久）、`created_by bigint NULL fk users SET NULL`。索引 `idx_sanctions_user (user_id, until)`、`idx_sanctions_board (board_id)`。
判定时机：发帖/回复的 service 里查「未过期且（board_id 为 NULL 或等于本分区）的处罚」——命中即 403 `forum.sanctioned`。

### 4.4 媒体

**images**（内容寻址）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| hash | char(64) | PRIMARY KEY | sha256 hex；与 URL 的 `/img/<hash>` 同形，便于人肉排查 |
| size | bigint | NOT NULL | 真实字节数 |
| mime | text | NOT NULL，ck in ('image/png','image/jpeg','image/gif','image/webp') | **SVG 不在列表里**（可内嵌脚本），由 CHECK 兜住 |
| refcount | int | NOT NULL DEFAULT 1 | 归零才删盘 |
| visibility | smallint | NOT NULL DEFAULT 0，ck in (0,1,2) | 0 公开 / 1 登录可见 / 2 本人与管理员 |
| owner_id | bigint | NULL fk users SET NULL | — |

索引：`idx_images_gc (refcount) WHERE refcount = 0`（部分索引，GC 任务扫它）。

**default_avatars**：`hash char(64) fk images CASCADE`、`sort int`，主键 `(hash)`。无头像用户按 `users.id % 池大小` 取一张。
**payment_channels**：`id`、`user_id fk CASCADE`、`label varchar(32)`、`image_hash char(64) fk images RESTRICT`、`sort int`。索引 `idx_payment_channels_user (user_id, sort)`。可见性 = 1（登录可见）。

### 4.5 通知

**notifications**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| user_id | bigint | NOT NULL fk users CASCADE | 收件人 |
| actor_id | bigint | NULL fk users SET NULL | 触发者（头像/昵称要显示） |
| type | varchar(32) | NOT NULL | reply / like / reward / system |
| payload | jsonb | NOT NULL DEFAULT '{}' | topic_id、post_id 等 |
| link | text | NOT NULL DEFAULT '' | 点击跳转 |
| read_at | ts | NULL | — |
| deleted_at | ts | NULL | 软删（只对自己隐藏） |

索引（**两个部分索引，这是 PG 才有的做法**）：
- `idx_notifications_inbox (user_id, created_at DESC) WHERE deleted_at IS NULL` —— 列表
- `idx_notifications_unread (user_id) WHERE read_at IS NULL AND deleted_at IS NULL` —— 未读角标

**notification_mutes**：`user_id`、`kind varchar(32)`（类别或 `link`）、`target_key text`，主键 `(user_id, kind, target_key)`，user 侧 CASCADE。

### 4.6 赞赏（**老设计：收款码 + 用户自报 + 管理员人工核验**）

用户已定：**收款按老设计**——作者挂自己的收款码，访客扫码支付后**自己申报**金额与单号，管理员**人工核验**后确认。
**硬约束：站点不经手资金**。因此 v2 第 12 章的 Gateway / 回调 / 对账 / Wallet / LedgerEntry **全部不需要**，本设计里没有钱包、没有余额、没有支付通道回调。

**donation_records**（打赏记录 = 申报单）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| public_id | uuid | NOT NULL UNIQUE | — |
| donor_id | bigint | NOT NULL fk users RESTRICT | 打赏人 |
| recipient_id | bigint | NOT NULL fk users RESTRICT | 收款人 |
| amount_cents | bigint | NOT NULL，ck (> 0) | 金额（分），申报值 |
| txn_id | varchar(64) | NOT NULL DEFAULT '' | 用户自报的支付单号/备注 |
| post_id | bigint | NULL fk topics SET NULL | 可关联帖子 |
| state | text | NOT NULL DEFAULT 'pending'，ck ('pending','approved','rejected','withdrawn') | 人工核验状态机 |
| note | varchar(200) | NOT NULL DEFAULT '' | 申报留言 |
| verified_by | bigint | NULL fk users SET NULL | 核验人 |
| verified_at | ts | NULL | 核验时间 |
| created_at | ts | NOT NULL DEFAULT now() | — |

索引：`idx_donation_records_queue (state, created_at DESC)`（管理核验队列）、`idx_donation_records_recipient (recipient_id, state, created_at DESC)`（主页收入侧）、`idx_donation_records_donor (donor_id, created_at DESC)`（支出侧）。
检查：`ck_donation_records_not_self (donor_id <> recipient_id)`。
规则：

- 只有 `approved` 计入统计；统计**只累加作者同意公开（`records_public`）的记录**。
- 用户可**撤回**自己 `pending` 的申报（置 `withdrawn`，不物理删）。
- 改判（approved↔rejected）**必须留痕**：写 `audit_logs`（action=`reward.verify`）。
- 全表没有「余额」概念，所以**不存在余额不变量**——第 12 章的自检里那条随之删除。

**payment_channels**、**user_donation_settings**、**donation_notice_defaults** 见 §4.4 与 §4.6 上文（收款码图、两个展示开关、按渠道的默认提示文案）。

### 4.7 下载（启动器索引，不存字节）

**releases**：`id`、`public_id uuid UNIQUE`、`version varchar(32) UNIQUE`、`channel text ck ('stable','beta')`、`notes_md text`、`notes_html text`、`published_at ts NULL`、`status text ck ('draft','published','archived')`、`updated_at`。
**release_assets**：`id`、`public_id uuid UNIQUE`、`release_id fk CASCADE`、`platform varchar(16)`、`arch varchar(16)`、`url text`（外部直链）、`size bigint`、`sha256 char(64)`、`download_count bigint NOT NULL DEFAULT 0`。
索引：`uq_release_assets (release_id, platform, arch)`、`idx_release_assets_release (release_id)`。
`download_count` 由 counter 缓冲批量写回（**禁止每请求 UPDATE**）。

### 4.8 邮件

**mail_accounts**：`id`、`name varchar(64) UNIQUE`、`provider text ck ('resend','smtp')`、`priority int`、`daily_limit int`、`reset_tz varchar(64)`、`from_address varchar(254)`、`from_name varchar(64)`、`options_json jsonb NOT NULL DEFAULT '{}'`（非敏感）、`secret_cipher bytea NULL`、`secret_nonce bytea NULL`、`secret_updated_at ts NULL`、`enabled boolean DEFAULT true`、`last_ok_at ts NULL`、`last_error text NULL`、`last_error_at ts NULL`、`updated_at`。
**mail_quota**：`account_id fk CASCADE`、`day date`、`count int NOT NULL DEFAULT 0`，主键 `(account_id, day)`。**用 PG 原生 `date`**，不再是字符串。
**mail_logs**：`id`、`idempotency_key varchar(128) UNIQUE`、`to_address varchar(254)`（`to` 是 SQL 关键字，列名避开）、`template varchar(64)`、`provider varchar(32)`、`status text ck ('pending','sent','failed')`、`provider_message_id text NULL`、`error text NULL`、`sent_at ts NULL`、`quota_account_id bigint NULL fk mail_accounts SET NULL`、`quota_day date NULL`、`attempts int NOT NULL DEFAULT 0`。
索引：`idx_mail_logs_status (status, created_at DESC)`。

### 4.9 站点

**site_settings**：`key varchar(64) PRIMARY KEY`、`value text NOT NULL DEFAULT ''`、`updated_at`。
**site_domains**：`domain varchar(253) PRIMARY KEY`、`is_primary boolean NOT NULL DEFAULT false`。部分唯一索引 `uq_site_domains_primary (is_primary) WHERE is_primary`（**只能有一个主域名**）。
**announcements**：`id`、`title varchar(120)`、`body_md text`、`body_html text`、`published_at ts NULL`、`created_by bigint NULL fk users SET NULL`。索引 `idx_announcements_published (published_at DESC NULLS LAST)`。
**banners**：`id`、`kind text ck ('info','warning','promo')`、`text varchar(200)`、`url text NULL`、`starts_at ts`、`ends_at ts NULL`、`enabled boolean NOT NULL DEFAULT true`。索引 `idx_banners_active (starts_at, ends_at) WHERE enabled`。
**banner_dismissals**：`banner_id fk CASCADE`、`user_id fk CASCADE`，主键 `(banner_id, user_id)`。

### 4.10 任务队列（jobs）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| type | varchar(64) | NOT NULL | 见 v2 §7.4 的常量 |
| payload | jsonb | NOT NULL DEFAULT '{}' | 不再自己序列化 bytes |
| unique_key | text | NOT NULL DEFAULT '' | 去重键 |
| status | text | NOT NULL DEFAULT 'pending'，ck ('pending','running','done','dead') | — |
| priority | int | NOT NULL DEFAULT 0 | 越大越优先 |
| run_at | ts | NOT NULL DEFAULT now() | — |
| attempts | int | NOT NULL DEFAULT 0 | — |
| max_retry | int | NOT NULL DEFAULT 5 | — |
| locked_until | ts | NULL | 崩溃恢复用 |
| locked_by | text | NULL | 哪个实例领的（以后多实例排查） |
| last_error | text | NULL | — |
| finished_at | ts | NULL | — |

索引：
- `uq_jobs_unique_key (unique_key) WHERE unique_key <> '' AND status IN ('pending','running')` —— **部分唯一索引**，任务 done 之后同一个 key 才能再次入队
- `idx_jobs_claim (priority DESC, run_at) WHERE status = 'pending'` —— 领取

**领取任务（一步，替代 SQLite 版的两步）**：

    SELECT * FROM jobs
     WHERE status = 'pending' AND run_at <= now()
     ORDER BY priority DESC, run_at
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

拿到行后在**同一事务**里 `UPDATE jobs SET status='running', locked_until=now()+interval '5 minutes', attempts=attempts+1 WHERE id=$1`。多个 worker 并发时 `SKIP LOCKED` 保证不会互相等待；因此**并发数不再受单写者限制**，worker 数可配（默认 4）。

### 4.11 私信、头衔与等级、资源帖 issue（本轮确认进 v1）

**messages**（一对一私信；不做会话表，用规范化用户对直接分组）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| low_id | bigint | NOT NULL fk users CASCADE | 规范化用户对：**恒为较小的 user id** |
| high_id | bigint | NOT NULL fk users CASCADE | 较大的那个 |
| sender_id | bigint | NOT NULL fk users CASCADE | 发送者（必为 low 或 high 之一） |
| body | text | NOT NULL | 纯文本（私信不做 Markdown 渲染） |
| read_at | ts | NULL | 收件人已读时间 |
| deleted_by_low | boolean | NOT NULL DEFAULT false | 各自删除互不影响 |
| deleted_by_high | boolean | NOT NULL DEFAULT false | 同上 |

索引：
- `idx_messages_pair_low  (low_id,  high_id, id DESC)`
- `idx_messages_pair_high (high_id, low_id,  id DESC)` —— **两侧都要**，否则 high 一侧的会话列表只能全表扫（30 秒轮询的热路径）
- 未读角标（部分索引，**必须带收件人条件**）：

      CREATE INDEX idx_messages_unread_low  ON messages (low_id)
        WHERE read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id;
      CREATE INDEX idx_messages_unread_high ON messages (high_id)
        WHERE read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id;

  `read_at` 是**收件人**的已读时间，所以"未读"= 我是收件人且未读；漏掉 `sender_id <> 我` 会让**自己发的消息计进自己的未读角标**（盲审 B3）。
检查：`ck_messages_pair_order (low_id < high_id)`、`ck_messages_sender_in_pair (sender_id IN (low_id, high_id))`。

规则：

- **拉黑**（`blocks`）生效时不允许发送：被拉黑方不能给对方发私信（service 层判）。
- **实时性按档位**：small（2GB）用轮询（会话内 5 秒、全局未读 30 秒）；**standard（4GB）用 SSE 推送 + 30 秒轮询兜底**（端到端延迟 <1 秒）。档位见 `性能与容量.md`。实现上 SSE 只是一个 handler + 每连接几 KB，**不要**引入 WebSocket 或额外组件。
- 私信正文**不进搜索索引**（隐私）。

**titles**：`id`、`key varchar(32)` UNIQUE、`name varchar(32)`、`color varchar(16)`（如 `#2563eb`）、`description varchar(200)`、`archived_at ts NULL`（归档不删）、`created_at`。
**user_titles**：`user_id`、`title_id`、`granted_at`、`granted_by bigint NULL fk users SET NULL`，主键 `(user_id, title_id)`，两侧 CASCADE。**多对多：一个用户可持多个头衔**。
**users.equipped_title_id**：另加一列 `bigint NULL fk titles ON DELETE SET NULL`——**佩戴的只有一个**；头衔被删除/归档时自动置空（这正是旧站 `repo_titles.rs:128` 手工做的那件事，现在由外键保证）。

**经验与等级**：`users.exp int NOT NULL DEFAULT 0`、`users.level int NOT NULL DEFAULT 1`。
**exp_events**：`id`、`user_id fk CASCADE`、`delta int NOT NULL`、`reason varchar(64)`、`ref varchar(64) NOT NULL DEFAULT ''`、`created_at`。索引 `idx_exp_events_user (user_id, created_at DESC)`。
不变量：`level = floor(sqrt(exp / 100)) + 1`（旧站 `community.rs:94-109` 同款公式）。**两条书写路径：写 exp 时必须同事务重算 level**；第 12 章加一条一致性检查。

**post_issues**（资源帖的「问题与建议」）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | bigint | identity pk | — |
| public_id | uuid | NOT NULL UNIQUE | — |
| topic_id | bigint | NOT NULL fk topics CASCADE | 所属资源帖 |
| author_id | bigint | NOT NULL fk users RESTRICT | — |
| kind | text | ck ('bug','feature','other') | — |
| title | varchar(120) | NOT NULL | — |
| body_md / body_html | text | NOT NULL | 与帖子同一套渲染与清洗 |
| status | text | NOT NULL DEFAULT 'open'，ck ('open','closed') | — |
| closed_by | bigint | NULL fk users SET NULL | — |
| closed_at | ts | NULL | — |

索引：`idx_post_issues_topic (topic_id, status, created_at DESC)`、`idx_post_issues_author (author_id)`。

**issue_comments**：`id`、`issue_id fk post_issues CASCADE`、`author_id fk users RESTRICT`、`parent_id bigint NULL fk issue_comments SET NULL`（同样只允许一级）、`body_md`、`body_html`、`status text ck ('normal','deleted','hidden')`、`like_count int DEFAULT 0`。索引 `idx_issue_comments_issue (issue_id, id)`、`idx_issue_comments_parent (parent_id)`。

**投票复用 `likes`**：`likes.target_type` 的 CHECK 扩展为 `('topic','post','issue','issue_comment')`——**不新建第二张投票表**（否则「切换赞」的规则要写两遍，正是复盘根因 2）。



PG 内置的 `to_tsvector` 对中文按「整段」处理，不做分词，直接用它搜中文等于搜不到。方案：**写入与查询都切 bigram（2-gram）**，不加载任何词典（原 gse 方案已按 `性能与容量.md` §2.1 删除——它一个实例就吃掉近百 MB）。两边切法必须一致，否则「搜不到」且很难查。

**索引表** `topic_search`（由 `search:index` 后台任务维护，不在发帖请求里同步写）：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| topic_id | bigint | PRIMARY KEY fk topics CASCADE | 一行一主题 |
| title | varchar(200) | NOT NULL | 标题原文 |
| body_text | text | NOT NULL DEFAULT '' | 1 楼正文的纯文本（去 markdown） |
| tokens | text | NOT NULL DEFAULT '' | `title + body_text` 切成 2-gram 后用空格连接（「中文搜索」→「中文 文搜 搜索」） |
| tsv | tsvector | `GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || tokens)) STORED` | **生成列：不可能与 tokens 漂移** |
| updated_at | ts | NOT NULL DEFAULT now() | — |

索引：`idx_topic_search_tsv USING gin (tsv)`；另外 `idx_topic_search_title_trgm USING gin (title gin_trgm_ops)` 给「标题模糊匹配」兜底。

查询：`SELECT t.id FROM topic_search s JOIN topics t ON t.id = s.topic_id
        WHERE s.tsv @@ plainto_tsquery('simple', $1)
          AND t.status = 'normal'`，其中 `$1` 是**按同样规则切好的 bigram 查询串**。

   **必须 JOIN topics 过滤状态**：`topic_search` 里没有 status 列，而 `pending`/`rejected`/`hidden`/`deleted` 的主题只有作者与管理员可见（§4.2）——只按 tsv 匹配等于**把未公开内容泄露给游客**（盲审 D2，安全级）。
   **不要**给 topic_search 加 status 冗余列：那是第二份状态，必然漂移。排序用 `ts_rank` 或直接按 `t.last_reply_at`。

依赖扩展：`CREATE EXTENSION IF NOT EXISTS pg_trgm;`（**必须是第一个迁移**）。pg_trgm 自 PG 13 起是 trusted extension，数据库属主可自行创建，不需要超级用户；服务端需要装 `postgresql-contrib`。

> 为什么不用 `zhparser`/`pg_jieba`：要编译安装、要超级用户、升级 PG 时要重来一遍。用 bigram + 生成列达到同样效果，代价是多一张索引表和一条后台任务——而这两样本来就有。

---

## 6. 迁移与 schema 管理

- **唯一真源**：`internal/ent/schema`。只改这里；`internal/ent` 下生成代码禁止手改。
- 生成：`go generate ./internal/ent`（特性开关加 `sql/lock`，PG 支持 `FOR UPDATE`）。
- 迁移文件：Atlas 生成 **postgres 方言**、golang-migrate 格式，落在 `migrations/postgres/`；手写迁移（扩展、生成列、部分索引、CHECK、`lower()` 唯一索引）用 `atlas migrate new`，改完必须 `atlas migrate hash`。
- 命令（已核实）：`atlas migrate diff <名> --dir "file://migrations/postgres?format=golang-migrate" --to "ent://internal/ent/schema" --dev-url "<PG URL>"`。**dev-url 不要用 `docker://`**：本机 Docker 守护进程没跑（实测 `docker info` 失败），指向本机或嵌入式 PG 实例即可。
- 生产**禁止** `client.Schema.Create`；它只允许出现在测试里。
- 已提交的迁移禁止修改，只能新增。
- 启动时校验：数据库的迁移版本与嵌入版本不一致 → **拒绝启动**并提示先跑 `forum migrate`。
- CI 必跑两条：
  1. 空库 → 执行全部迁移 → 与 ent schema snapshot 比对（两条 DDL 路径必须一致）；
  2. 第 12 章的 SQL 自检（外键索引、权限点一致性、CHECK 覆盖率）。
- 扩展与生成列只能写在手写迁移里，Atlas 不会替我们生成。

---

## 7. 连接与内存预算（2 核 2 GB）

    // internal/platform/db/open.go 的要点
    cfg, _ := pgxpool.ParseConfig(cfg.DSN)     // 例：postgres://forum:***@127.0.0.1:5432/forum?sslmode=disable
    cfg.MaxConns = 16                           // 2 核机器：连接数不是越多越好
    cfg.MinConns = 2
    cfg.MaxConnLifetime = time.Hour
    cfg.MaxConnIdleTime = 30 * time.Minute
    cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"        // 会话级 UTC，不依赖服务端配置
    cfg.ConnConfig.RuntimeParams["application_name"] = "forum"
    pool, _ := pgxpool.NewWithConfig(ctx, cfg)
    db := entsql.OpenDB(dialect.Postgres, stdlib.OpenDBFromPool(pool))  // 已核实：必须这样接
    // 不要用 ent.Open("postgres", ...)：那条路要的是 lib/pq，而 pgx 的 stdlib 注册名是 pgx / pgx/v5

| 项 | 预算 |
|---|---|
| pgxpool 16 连接 | 每连接约 1–2 MB 工作内存 → ≤ 32 MB |
| PG 服务端 shared_buffers | 256 MB（PG 自己的内存，不占 Go 进程） |
| PG 服务端 work_mem | 4 MB（默认 4MB 够；排序大的查询单独调） |
| Go 进程其它 | 见 `性能与容量.md`（原 §9.6 的预算表已作废） |

其它参数：`statement_cache_mode=describe`（避免与连接池准备语句爆炸）；**不引入 pgbouncer**（单机单应用，多一层反而多一处故障）；`max_connections` 服务端设 50，留出 psql 与 pg_dump 的余量。

---

## 8. 备份与恢复

- 备份：`pg_dump -Fc -f forum-YYYYmmdd-HHMM.dump forum`（自定义格式，可选择性恢复）。进程内 cron 每小时一次，保留「最近 24 份 + 每天 1 份 × 7 天」。
- 磁盘闸门：备份目录剩余空间 < 库大小 × 2 时跳过本次并记 Warn（**绝不因为备份把磁盘写满**）。
- 恢复：`pg_restore -d forum --clean --if-exists forum-*.dump`；图片目录仍是内容寻址 + rsync 单独同步（不在 dump 里）。
- 恢复流程：停服 → 恢复库 → 恢复图片 → 起服（启动会校验迁移版本）→ `forum check`。
- 备份**不含**发信/支付凭据主密钥（它在环境变量里），这是有意的：快照泄露 ≠ 凭据泄露。

---

## 9. 测试数据库

- 单元/集成测试**必须跑真实 PG**（不再是 `t.TempDir()` 里的 SQLite 文件）。
- 开发机（Windows，没装 PG）：用嵌入式 PG（`github.com/fergusstrange/embedded-postgres`）在 127.0.0.1 的随机端口起一个临时实例，测试进程内共享，退出即清理。**不要求 Docker**。
- CI：优先用 service container；没有 Docker 时退回嵌入式 PG。
- 每个测试用例用**独立 schema**（`CREATE SCHEMA test_xxx; SET search_path`）而不是独立库，省掉建库开销；跑完 `DROP SCHEMA ... CASCADE`。
- 测试里建表允许 `client.Schema.Create`；**另有一组「走迁移」的测试**（空库执行嵌入迁移 → 跑基本读写），保证迁移文件本身可用。
- 【已核实】本机没有 PostgreSQL，也没有可用的 Docker（`docker info` 失败）→ 结论：**用 embedded-postgres v1.34.0**（默认下载 18.3.0，约 24MB）；它默认端口是 5432，**测试里必须显式改成随机端口**，避免撞上真库。testcontainers-go（v0.44.0）作为以后有 Docker 时的备选。

---

## 10. 旧站数据迁移：**只迁用户**

### 10.1 范围（已定案：完整迁移用户数据）

- **完整迁移与用户有关的一切**：账号本身、密码、邮箱与验证状态、角色、头衔与佩戴、等级与经验流水、头像（含小图与默认头像）、简介、打赏三个开关与提示文案、激活状态、封禁/处罚记录、拉黑关系。
- **不迁**：帖子、回复、图片（**头像除外**）、通知、打赏记录、私信。网盘已放弃，其文件与配额一律不迁。
- 新 users 表是**全新设计**（§4.1），所以这是一次**语义映射**，不是列复制。任何「旧列直接搬新列」的写法都是错的。
- 实现为独立子命令 `forum import-users`，**只新增、不修改、不删除**已存在的行；可重复执行（幂等）。
- 迁移**不改 schema**；它跑的库必须已经 `forum migrate` 过。

### 10.2 映射规则（逐字段）

| 新列 | 来源与规则 |
|---|---|
| id | 新自增，**保留旧 id 的对应关系**只写进 `import_map`（见 10.4），不用旧 id 当新主键 |
| public_id | 新生成 UUID v7，与旧 id 无关 |
| username | 旧 handle；**冲突处理**：`lower(username)` 在旧库里已唯一（旧库是 ASCII 唯一），到新库仍需按 `lower()` 复查；大小写不同的重名视为冲突，保留最早注册的，其余加后缀并在报告里列出 |
| email | 旧 email；**归一化后按 `lower()` 去重**；旧库若存在同一邮箱多账号，只保留最早的一个，其余记入冲突报告 |
| password_hash | **原样搬**（旧站也是 argon2id）：格式串一致就直接可用，用户不必重置密码。**【待确认】需核实旧站 argon2id 的参数与编码格式是否与本方案 §9.1 完全一致**，不一致就必须在首次登录时按新参数重算（记录 `needs_rehash`），或强制重置 |
| nickname | 旧 display_name；空则回落到 username |
| avatar_hash / avatar_small_hash | **搬**：按旧 hash 从 `blobs` 复制字节到新图片根目录，写 `images` 行（visibility=0，owner=该用户），再填两列；`default_avatar_hash` 迁进默认头像池并保持「分一次就固定」的语义（**不要改成按 id 取模重算**，否则头像会换） |
| bio | 旧简介（≤200 字），超长截断并记入报告 |
| status | 旧「停用/封禁」→ `banned`；旧「未激活」不是 status，而是 `email_verified_at = NULL` |
| email_verified_at | 【待确认】旧站是否真的验证过邮箱。若旧库没有可信的验证时间：**一律置 NULL**，让用户走一次验证邮件（安全默认） |
| last_login_at | 旧库若有最后登录时间则搬，否则 NULL |
| 角色 | 旧 4 级角色 → 映射到 `superadmin` / `admin` / `creator` / `user` 四个内置 `roles`，写 **`users.role_id`**（单一角色）。旧站在新库不再有角色列——角色是外键，不是散列 |
| activated_at | 旧 `activated_at`（Unix 秒）→ 新 `activated_at`（timestamptz）。**注意**：旧站的"激活"是管理员/策略门槛，**不是邮箱验证**，所以**不许**映射到 `email_verified_at`（盲审 D1/B4；映射错会让这批人要么被锁死、要么获得写权限，且不可逆） |
| trusted | 旧 `trusted`（1 = 发帖跳过人工审核）→ 新 `trusted`；旧库若是 0/1 整数，按 `<> 0` 转 boolean |
| 头衔 / 等级 / 经验 | **完整迁移**：`titles` → `titles`（key/name/color/description，归档态保留）、`user_titles` → 同表、`equipped_title_id` → 同列；`exp`/`level` 原值搬（**并校验 level = floor(sqrt(exp/100))+1，不一致时以 exp 重算并记入报告**）、`exp_events` → 同表 |
| 磁盘配额（quota_bytes / used_bytes） | **不迁**：网盘已放弃，新设计没有配额概念 |

### 10.3 幂等与冲突

- 幂等键：`lower(username)`。已存在则**跳过**（不更新），并计入「已存在」计数。
- 冲突输出：`--report out.csv`，列 `old_id, username, email, 冲突原因, 处理结果`。
- 全程包在**单个事务**里（要么全成，要么全不成），或按 `--batch 500` 分批并记录断点。**默认单事务**——用户量不大，简单优先。
- 导入对象是**旧库的只读连接**：`--from "postgres://…"` 或直接读旧 SQLite 文件的只读副本。**绝不连生产旧库写入**。

### 10.4 import_map（回查用）

    CREATE TABLE import_map (
      source    text NOT NULL,          -- 'legacy-users'
      old_id    text NOT NULL,
      new_id    bigint NOT NULL,
      imported_at ts NOT NULL DEFAULT now(),
      PRIMARY KEY (source, old_id)
    );

存在的意义：迁移完成后要能回答「这个人是旧库里的谁」——排查账号问题、追日志、以后要补迁别的表都用得上。这张表**不进 ent schema**（它是一次性工具表，不进业务模型）。

### 10.5 迁移前必须拍板的事

| 编号 | 事项 | 默认建议 |
|---|---|---|
| I1 | 旧密码哈希 | **已定案：完整迁移**。PHC 串自描述，能直接校验；但旧参数 m=19MiB/t=2/p=1 弱于新规格，**登录成功时按新参数重算写回** |
| I2 | 邮箱验证状态 | **已定案：完整迁移**。旧库有 `email_codes`（consumed 的 verify 记录）就按它判定 `email_verified_at`；判不出来的一律未验证（安全默认） |
| I3 | 头像文件 | **已定案：搬**。把旧 `blobs` 里头像字节按 hash 复制进新图片根目录并写 `images` 行；`avatar_hash`/`avatar_small`/`default_avatar_hash`(→默认头像池) 一并迁移 |
| I4 | 等级/经验/头衔 | **已定案：完整迁移**（表已加：`users.exp`/`users.level`/`users.equipped_title_id`、`titles`、`user_titles`、`exp_events`，见 §4.11）。**磁盘配额不迁**——网盘已放弃，配额没有对应物 |

---

## 11. 与旧站 users 的对照

旧站 users 表的**确切列清单、每列的语义、哪些是死列、密码哈希格式**由调查产出：见 `旧站用户表提取.md`。
本节只记结论性规则：

1. **不复制任何旧列结构**。旧表是 36 份迁移只加不删堆出来的，含语义已废的列（复盘根因 8）。新表按 §4.1 重新设计。
2. **角色从旧站的列变成新库的外键**（`users.role_id`）。导入时按映射表一次性转换，之后新库只有这一处角色来源。
3. **大小写不敏感的归一化列取消**，改表达式唯一索引。
4. **旧表的「激活」语义**映射到 `email_verified_at IS NOT NULL`，不再是一个独立列。
5. **头衔/等级/经验/配额不进新库**（除非 I4 拍板要保留）。
6. **死列一律不带过来**：导入程序只读它需要的列，读不到的列按默认值处理，并在报告里列出「旧库缺少的列」。

---

## 12. 一致性自检（必须能红）

以下每条都要落成脚本或测试，跑在 CI 与 `forum check` 里。**只写在文档里的规则等于没有规则**（复盘根因 11）。

1. **外键索引检查**（PG 不自动建 FK 索引，这条最容易被忽略）：

       SELECT c.conrelid::regclass AS tbl, c.conname
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indrelid = c.conrelid
               AND i.indisvalid                 -- 排除建失败的索引
               AND i.indpred IS NULL            -- 排除部分索引：RI 查找用不了它
               AND (i.indkey::smallint[])[0:array_length(c.conkey,1)-1] @> c.conkey
          );

   有结果即失败。**注意三件事**（盲审核实过）：
   ① 切片与 `@>` 的写法本身是对的（`indkey` 是 0 基，`int2vector → int2[]` 走 ArrayCoerceExpr 保留 0 基）；
   ② 必须带 `indisvalid` 与 `indpred IS NULL`，否则**部分索引会被误判为已覆盖**，删父行时照样全表扫；
   ③ 这条检查只保证"外键列上有可用索引"，**复合主键的第二列不算已索引**（例如 `bookmarks.topic_id`、`board_moderators.user_id`、`topic_images.topic_id`）——这些列都是级联删除的真实路径，**要么补单列索引，要么在 CI 里放一份负例夹具证明这条检查真会红**（空库跑通不算验收）。

2. **迁移版本一致**：DB 里 `schema_migrations` 的最新版本 == 嵌入的最新版本，否则拒绝启动。
3. **权限点一致**：代码常量集合 == `permissions.key` 集合（代码有表里没有 → 启动失败；表里有代码没有 → Warn）。
4. **枚举值一致**：每个 `text + CHECK` 列的值域 == Go 常量集合（用 `pg_constraint` 解析 CHECK 表达式比对），不一致即失败。
5. **经验与等级一致**：`users.level = floor(sqrt(users.exp / 100)) + 1`，不一致即失败（旧站是冗余列，靠约定同步）。
6. **打赏状态机**：`donation_records` 里不存在既非 pending 又无 `verified_by` 的 approved/rejected 行（人工核验必须留核验人）。
7. **孤儿多态行**：`likes` / `reports` 里 `target_id` 已不存在的行数（多态无外键的代价，必须有人盯）。
8. **图片引用一致**：`images.refcount` 与各引用表的实际引用数不符的行数。
9. **迁移与 schema 一致**：空库跑迁移的结果 vs ent schema snapshot（Atlas diff）。
10. **无未索引的外键 + 无重复索引**：第二条用 `pg_index` 自比较（同一列序列出现两次即失败）。
11. **慢查询闸门**：CI 里对列表类查询跑 `EXPLAIN (ANALYZE, BUFFERS)`，断言**没有 Seq Scan 出现在 topics/posts/notifications 上**（表小于 1000 行时豁免）。

---

## 13. 待确认

| 编号 | 事项 | 影响 |
|---|---|---|
| G1 | PostgreSQL 版本（17 还是 18）与部署方式（本机 apt / Docker） | 生成列、pg_trgm、uuidv7 可用性；不影响表设计 |
| G2 | 是否已有可用的 PG 实例（生产机与服务端内存预算） | 部署脚本 |
| G3 | `pg_trgm` 是否需要（只做标题模糊匹配） | 不装则删掉对应索引与扩展迁移 |
| G4 | 嵌入式 PG vs 本机 PG vs testcontainers（测试） | 见 `postgres-选型核实.md` |
| I1–I4 | 见 §10.5 | 用户迁移的实现细节 |
| G5 | ~~是否保留等级/经验/头衔~~ **已定案：保留并完整迁移** | 见 §4.11 与 §10.5 I4 |
| G6 | 分词表 `topic_search` 的刷新策略（发帖即入队 vs 定时全量重建） | 搜索新帖的可见延迟 |

