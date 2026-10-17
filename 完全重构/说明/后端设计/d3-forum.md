# D3 论坛核心域后端设计（分区 / 主题 / 回复 / 投票 / 收藏 / 拉黑 / 禁言 / 下载源 / Issue）

> 归属模块：`internal/forum`。表 **12 张**：boards、board_acls、board_moderators、topics、posts、topic_sources、post_issues、issue_comments、likes、bookmarks、blocks、sanctions。
> **第 13 张 `topic_images` 归 D5**（帖子配图关联）；`boards` 的**管理端** CRUD 归 D2（它实现 `/admin/boards*`，用本域的表）——本域只定它的列与索引。
> 迁移落点：`migrations/postgres/0005_forum.sql`（本域全部 DDL）。
> 优先级：`后端开工前拍板.md` > 本文 > `数据库设计-postgresql.md` > `论坛后端技术方案-v2.md`。本文与拍板冲突的地方一律是本文错，照拍板改。
> 本文只做设计：**不写 `.go`、不改 go.mod、不动 `internal/ent/schema/`**。与旧文档的冲突与未决问题在 §12。
> 本文所有 SQL 都用 `pglast`（libpg_query 8.5）逐条解析通过；命令见 §13。

---

## 0. 本域一句话

**本域全部的正确性风险集中在一件事上：谁能看见哪一行。**
两条互相独立的轴（`visibility` 公开轴、`review_state` 审核轴）× 三种身份（游客 / 作者本人 / 持权限者）互相正交。
任何一条读路径漏写一个条件就是一次真实的信息泄漏；而列表是热路径，**泄漏与慢查询会同时发生**。
所以本文的做法只有三条：

1. **过滤条件只写一次**：`liveTopicCond` 与 `livePostCond` 两个 Go 常量（§3.2），本域所有列表/详情/计数语句都引用它们；
2. **游标排序键与索引逐字对齐**，每条查询写明它吃哪个索引（§3.1 的索引总表：**每个索引都必须能说出它服务哪条查询，说不出就删**）；
3. **写路径上的判定顺序写下来**（§4.1），不靠实现者记忆。

三条与旧文档不同的硬结论，先给在这里：

| # | 结论 | 为什么 |
|---|---|---|
| 1 | `topics.last_reply_at` **NOT NULL**，建主题时 = 1 楼的 `created_at` | 「没有回复」不是一个状态，是「最后一条楼层就是 1 楼」。排序键永远非空，游标就不需要 `NULLS LAST` 的三分支特判；`DESC NULLS LAST` 仍写在索引里（此刻它是空操作，但语义上对齐拍板 §5.1） |
| 2 | 投票 / 收藏 / 拉黑全部**幂等且无显式锁**：`UPDATE ... WHERE 旧值 <> 新值` 的 CAS + 计数增量写在同一条语句里 | 并发重放与「先查再写」的竞态在同一处解决；不需要 `SELECT FOR UPDATE`，也不需要读-改-写两次往返 |
| 3 | **置顶主题不参与游标翻页**，单独一条查询（每分区 ≤ 5 条） | 把 `pinned_at` 放进排序键，置顶帖会在**每一页**重复出现；把它放进 `WHERE` 又会让「取消置顶」的帖瞬间消失。单独查询是唯一既正确又便宜的做法 |

---

## 1. 表清单与不建的表

| # | 表 | 一句话 | 谁写它 |
|---|---|---|---|
| 1 | boards | 分区（表驱动，新增分区零代码改动） | 管理端 `board.manage` |
| 2 | board_acls | 分区 × 角色的发言四象限 | 管理端 `board.manage` |
| 3 | board_moderators | 分区版主，`board.moderate` 的作用域来源 | 管理端 `board.manage` |
| 4 | topics | 主题（三种 kind + 两条独立状态轴） | forum |
| 5 | posts | 楼层（1 楼 = 主题正文，楼中楼只允许一级） | forum |
| 6 | topic_images | 帖子配图关联（**封面由此派生**，不存列） | **D5**（`d5-content.md` §4.1；本域只读它做封面） |
| 7 | topic_sources | 资源帖下载源 + 维护状态 | forum |
| 8 | post_issues | 资源帖的问题与建议 | forum |
| 9 | issue_comments | issue 评论（同样只允许一级楼中楼） | forum |
| 10 | likes | 赞/踩，**一张表四种目标** | forum |
| 11 | bookmarks | 收藏主题 | forum |
| 12 | blocks | 拉黑 | forum |
| 13 | sanctions | 分区级限期禁言 | 管理端 `user.mute`（D2 实现端点，本域定表与本域的判定） |

**明确不建**（拍板 §6，写在这里是为了以后不再讨论）：

| 不建 | 落点 |
|---|---|
| `board_members` / `boards.member_count` / `joined` | 关注分区已作废（2026-10-12）。分区页的「成员」格从设计里去掉 |
| `boards.topic_count` / `post_count` / `today_count` | **由 `topics` 现算**（§3.3 的 LATERAL 计数），见下方「为什么不做计数列」 |
| `post_revisions` | 「请求修改」= `topics.review_note` + 作者自行编辑（拍板 §6） |
| `topics.sort` / `pinned_rank` | 置顶用 `pinned_at` + 单独查询（§3.3） |
| `issue_labels` / `issue_label_links` | 后置；四类 kind 已覆盖本社区的分类需求 |
| `post_issues.open_count` | topic 详情一条 `count(*) WHERE (topic_id, status)` 就够（拍板 §6 最后一行） |
| 顶层评论的 `reply_count` 列 | 「查看全部 N 条回复」用同页的 `count(*)` 算（§3.4） |

**为什么 `boards` 不做计数列**：分区页要显示主题数/回复数/今日新帖。三个数都能从 `topics` 用索引现算（§3.3），
而计数列要挂在**每一次发帖、删帖、跨分区移动**上同步——那是三处新的漂移点，换来的只是把一条毫秒级查询变成一条微秒级查询。
分区只有十几个，这条 LATERAL 反正每行都要跑一次。

---

## 2. 表结构（DDL，可直接执行）

> 全局约定照 `数据库设计-postgresql.md` §2：`bigint GENERATED ALWAYS AS IDENTITY`、`public_id uuid NOT NULL UNIQUE`（应用生成 v7，**无 DB 默认值**）、时间一律 `timestamptz`、枚举一律 `text + CHECK`（**禁止 PG 原生 enum**）、布尔 `boolean NOT NULL DEFAULT false`、每表都有 `created_at`。
> 删除策略：内容软删（`visibility`），纯关联表 `ON DELETE CASCADE`，`users` 永不硬删。
> **所有可变列（`*_at`、计数、`sort`）由应用写，不建触发器**（数据库文档 §2.12）。

### 2.1 完整 DDL（`migrations/postgres/0005_forum.sql`）

```sql

CREATE TABLE boards (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug           varchar(32)  NOT NULL UNIQUE,
  name           varchar(32)  NOT NULL,
  description    varchar(200) NOT NULL DEFAULT '',
  sort           int          NOT NULL DEFAULT 0,
  status         text         NOT NULL DEFAULT 'active',
  cover_hash     char(64)     NULL REFERENCES images(hash) ON DELETE SET NULL,
  acl_enabled    boolean      NOT NULL DEFAULT false,
  min_post_level int          NOT NULL DEFAULT 0,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_boards_status CHECK (status IN ('active','archived')),
  CONSTRAINT ck_boards_min_post_level CHECK (min_post_level >= 0)
);
CREATE INDEX idx_boards_sort ON boards (sort, id);

CREATE TABLE board_acls (
  board_id    bigint  NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  role_id     bigint  NOT NULL REFERENCES roles(id)  ON DELETE CASCADE,
  can_post    boolean NOT NULL DEFAULT false,
  can_reply   boolean NOT NULL DEFAULT false,
  deny_post   boolean NOT NULL DEFAULT false,
  deny_reply  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, role_id),
  CONSTRAINT ck_board_acls_no_contradiction CHECK (NOT (deny_post AND can_post) AND NOT (deny_reply AND can_reply))
);
CREATE INDEX idx_board_acls_role ON board_acls (role_id);

CREATE TABLE board_moderators (
  board_id   bigint NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX idx_board_moderators_user ON board_moderators (user_id);

CREATE TABLE topics (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid         NOT NULL UNIQUE,
  board_id        bigint       NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
  author_id       bigint       NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  kind            text         NOT NULL DEFAULT 'discussion',
  title           varchar(200) NOT NULL,
  excerpt         varchar(200) NOT NULL DEFAULT '',
  visibility      text         NOT NULL DEFAULT 'normal',
  review_state    text         NOT NULL DEFAULT 'approved',
  review_note     varchar(500) NULL,
  reviewed_by     bigint       NULL,        -- 审核人（历史记录，无外键：用户永不硬删，见 §2.2）
  reviewed_at     timestamptz  NULL,
  locked_at       timestamptz  NULL,
  pinned_at       timestamptz  NULL,
  featured_at     timestamptz  NULL,
  resource_status text         NULL,
  client_token    varchar(64)  NOT NULL DEFAULT '',
  reply_count     int          NOT NULL DEFAULT 0,
  like_count      int          NOT NULL DEFAULT 0,
  view_count      bigint       NOT NULL DEFAULT 0,
  last_reply_at   timestamptz  NOT NULL DEFAULT now(),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_topics_kind CHECK (kind IN ('discussion','resource','repost')),
  CONSTRAINT ck_topics_visibility CHECK (visibility IN ('normal','hidden','deleted')),
  CONSTRAINT ck_topics_review_state CHECK (review_state IN ('pending','approved','rejected')),
  CONSTRAINT ck_topics_resource_status CHECK (resource_status IS NULL OR resource_status IN ('maintained','bugfix_only','unmaintained')),
  CONSTRAINT ck_topics_resource_status_kind CHECK (resource_status IS NULL OR kind = 'resource'),
  CONSTRAINT ck_topics_counts_nonneg CHECK (reply_count >= 0 AND like_count >= 0 AND view_count >= 0),
  CONSTRAINT ck_topics_deleted_no_pin CHECK (visibility <> 'deleted' OR (pinned_at IS NULL AND featured_at IS NULL))
);

CREATE INDEX idx_topics_recent ON topics (last_reply_at DESC NULLS LAST, id DESC) WHERE visibility = 'normal';
CREATE INDEX idx_topics_board_live ON topics (board_id, last_reply_at DESC NULLS LAST, id DESC) WHERE visibility = 'normal';
CREATE INDEX idx_topics_board_new ON topics (board_id, created_at DESC, id DESC) WHERE visibility = 'normal';
CREATE INDEX idx_topics_kind_new ON topics (kind, created_at DESC, id DESC) WHERE visibility = 'normal';
CREATE INDEX idx_topics_featured ON topics (featured_at DESC, id DESC) WHERE visibility = 'normal' AND featured_at IS NOT NULL;
CREATE INDEX idx_topics_pinned ON topics (board_id, pinned_at DESC, id DESC) WHERE visibility = 'normal' AND pinned_at IS NOT NULL;
CREATE INDEX idx_topics_author ON topics (author_id, created_at DESC, id DESC);
CREATE INDEX idx_topics_board_id ON topics (board_id);
CREATE UNIQUE INDEX uq_topics_author_client_token ON topics (author_id, client_token) WHERE client_token <> '';
CREATE INDEX idx_topics_review_queue ON topics (review_state, created_at DESC, id DESC) WHERE review_state <> 'approved';

CREATE TABLE posts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     uuid        NOT NULL UNIQUE,
  topic_id      bigint      NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  author_id     bigint      NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  parent_id     bigint      NULL REFERENCES posts(id) ON DELETE SET NULL,
  floor         int         NOT NULL,
  content_md    text        NOT NULL,
  content_html  text        NOT NULL,
  visibility    text        NOT NULL DEFAULT 'normal',
  client_token  varchar(64) NOT NULL DEFAULT '',
  like_count    int         NOT NULL DEFAULT 0,
  dislike_count int         NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_posts_floor CHECK (floor >= 1),
  CONSTRAINT ck_posts_visibility CHECK (visibility IN ('normal','hidden','deleted')),
  CONSTRAINT ck_posts_counts_nonneg CHECK (like_count >= 0 AND dislike_count >= 0)
);
CREATE UNIQUE INDEX uq_posts_topic_floor ON posts (topic_id, floor);
CREATE INDEX idx_posts_topic_id ON posts (topic_id, id);
CREATE INDEX idx_posts_author ON posts (author_id);
CREATE INDEX idx_posts_parent ON posts (parent_id);
CREATE INDEX idx_posts_author_client_token ON posts (author_id, client_token) WHERE client_token <> '';

/* topic_images 归 D5（d5-content.md §4.1）：主键 (topic_id, image_hash) + sort，见 §2.2 的说明 */
CREATE TABLE topic_sources (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic_id        bigint       NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  provider        varchar(24)  NOT NULL,
  label           varchar(60)  NOT NULL DEFAULT '',
  url             text         NOT NULL,
  extraction_code varchar(16)  NULL,
  size_text       varchar(16)  NOT NULL DEFAULT '',
  upkeep          text         NOT NULL DEFAULT 'active',
  go_count        bigint       NOT NULL DEFAULT 0,
  verified_at     timestamptz  NULL,
  sort            int          NOT NULL DEFAULT 0,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_topic_sources_provider CHECK (provider IN
    ('baidu','aliyun','quark','lanzou','pan123','weiyun','onedrive','mega','website','github','gitee','other')),
  CONSTRAINT ck_topic_sources_url CHECK (url ~ '^https?://'),
  CONSTRAINT ck_topic_sources_upkeep CHECK (upkeep IN ('active','archived')),
  CONSTRAINT ck_topic_sources_size CHECK (size_text = '' OR size_text ~ '^[0-9]+([.][0-9]+)? ?(B|KB|MB|GB|TB)$'),
  CONSTRAINT ck_topic_sources_code CHECK (extraction_code IS NULL OR extraction_code ~ '^[A-Za-z0-9]{1,16}$'),
  CONSTRAINT ck_topic_sources_go_count CHECK (go_count >= 0)
);
CREATE INDEX idx_topic_sources_topic ON topic_sources (topic_id, sort, id);

CREATE TABLE post_issues (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     uuid         NOT NULL UNIQUE,
  topic_id      bigint       NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  author_id     bigint       NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  assignee_id   bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  number        int          NOT NULL,
  kind          text         NOT NULL,
  title         varchar(120) NOT NULL,
  body_md       text         NOT NULL,
  body_html     text         NOT NULL,
  body_text     text         NOT NULL DEFAULT '',
  tags          text[]       NOT NULL DEFAULT '{}',
  status        text         NOT NULL DEFAULT 'keep_open',
  closed_by     bigint       NULL,           -- 关闭人（历史记录，无外键：同 reviewed_by）
  closed_at     timestamptz  NULL,
  client_token  varchar(64)  NOT NULL DEFAULT '',
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_post_issues_kind CHECK (kind IN ('bug','feature','difficulty','other')),
  CONSTRAINT ck_post_issues_status CHECK (status IN ('keep_open','closed')),
  CONSTRAINT ck_post_issues_number CHECK (number >= 1),
  CONSTRAINT ck_post_issues_tags CHECK (array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 5),
  CONSTRAINT ck_post_issues_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_post_issues_topic_number ON post_issues (topic_id, number);
CREATE INDEX idx_post_issues_global ON post_issues (status, updated_at DESC, id DESC);
CREATE INDEX idx_post_issues_tags ON post_issues USING gin (tags);
CREATE INDEX idx_post_issues_topic_status ON post_issues (topic_id, status, updated_at DESC, id DESC);
CREATE INDEX idx_post_issues_author ON post_issues (author_id, id DESC);
CREATE INDEX idx_post_issues_assignee ON post_issues (assignee_id) WHERE assignee_id IS NOT NULL;
CREATE UNIQUE INDEX uq_post_issues_author_client_token ON post_issues (author_id, client_token) WHERE client_token <> '';

CREATE TABLE issue_comments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id     uuid   NOT NULL UNIQUE,
  issue_id      bigint NOT NULL REFERENCES post_issues(id) ON DELETE CASCADE,
  author_id     bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  parent_id     bigint NULL REFERENCES issue_comments(id) ON DELETE SET NULL,
  body_md       text   NOT NULL,
  body_html     text   NOT NULL,
  visibility    text   NOT NULL DEFAULT 'normal',
  like_count    int    NOT NULL DEFAULT 0,
  dislike_count int    NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_issue_comments_visibility CHECK (visibility IN ('normal','hidden','deleted')),
  CONSTRAINT ck_issue_comments_counts_nonneg CHECK (like_count >= 0 AND dislike_count >= 0)
);
CREATE INDEX idx_issue_comments_issue ON issue_comments (issue_id, id);
CREATE INDEX idx_issue_comments_author ON issue_comments (author_id);
CREATE INDEX idx_issue_comments_parent ON issue_comments (parent_id);

CREATE TABLE likes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text     NOT NULL,
  target_id   bigint   NOT NULL,
  value       smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_likes_target_type CHECK (target_type IN ('topic','post','issue','issue_comment')),
  CONSTRAINT ck_likes_value CHECK (value IN (1, -1))
);
CREATE UNIQUE INDEX uq_likes_user_target ON likes (user_id, target_type, target_id);
CREATE INDEX idx_likes_target ON likes (target_type, target_id);

CREATE TABLE bookmarks (
  user_id    bigint NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  topic_id   bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);
CREATE INDEX idx_bookmarks_user ON bookmarks (user_id, created_at DESC, id DESC);
CREATE INDEX idx_bookmarks_topic ON bookmarks (topic_id);

CREATE TABLE blocks (
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_user_id),
  CONSTRAINT ck_blocks_not_self CHECK (user_id <> target_user_id)
);
CREATE INDEX idx_blocks_target ON blocks (target_user_id);

CREATE TABLE sanctions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id   bigint      NULL REFERENCES boards(id) ON DELETE CASCADE,
  action     text        NOT NULL DEFAULT 'reply',
  reason     varchar(200) NOT NULL DEFAULT '',
  until      timestamptz NULL,
  created_by bigint      NULL,        -- 开单人（历史记录，无外键：同 reviewed_by）
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sanctions_action CHECK (action IN ('post','reply','all'))
);
CREATE INDEX idx_sanctions_user ON sanctions (user_id, until);
CREATE INDEX idx_sanctions_board ON sanctions (board_id);
```

### 2.2 逐列说明（只写 DDL 看不出来的那些）

**boards**

| 列 | 语义 |
|---|---|
| `slug` | URL 里的标识（`/b/mod`）。`varchar(32)` + 唯一。**不可改**（改 slug 等于废掉所有外链） |
| `sort` | 展示顺序，升序 |
| `status` | `archived` = 不再出现在分区列表与发帖选择器里，**但已存在的主题仍可读**（不是软删） |
| `cover_hash` | 分区封面，内容寻址（D5）。`ON DELETE SET NULL`：图片被 GC 时分区不会跟着消失 |
| `acl_enabled` | false = **不做 ACL 判定，登录即可发言**（拍板 §1.5 第 3 步）。默认 false 是刻意的：新建分区不该一上线就没人能发帖 |
| `min_post_level` | 发帖门槛（等级）。0 = 不限。判定见 §6.4 |

**topics —— 本域最重要的表**

| 列 | 语义 |
|---|---|
| `kind` | `discussion` / `resource` / `repost`（拍板 §2.1）。**只有 `resource` 能挂 topic_sources 与非空 resource_status**（CHECK + service 层） |
| `visibility` | **公开轴**：`normal` / `hidden`（管理员隐藏）/ `deleted`（软删）。默认 `normal` |
| `review_state` | **审核轴**：`pending` / `approved` / `rejected`。默认 `approved` |
| `review_note` | 「请求修改」给作者看的话。`action=request_revision` 时必填（service 层） |
| `locked_at` | 非空 = 锁定（不能再回复）。**锁定不是可见性**，所以它是第三根独立的轴，不塞进 visibility |
| `pinned_at` / `featured_at` | 非空 = 置顶 / 精华。时间戳既当开关又当「什么时候加的」 |
| `resource_status` | `maintained` / `bugfix_only` / `unmaintained`，仅 `kind=resource`。**与 topic_sources.upkeep 回答的是两个问题**：这个回答「整个资源还有人维护吗」，那个回答「这一条链接还是活的吗」 |
| `excerpt` | 列表卡片要的摘要（`界面施工` §4.1）。写入时由 1 楼正文派生、截到 200 字符。**必须有这一列**：列表查询若去读 `posts.content_html`（TOAST 正文），首页 20 行就是 20 次大字段读取 |
| `client_token` | 幂等键（§4.3）。默认空串 = 不带幂等；部分唯一索引只在非空时生效 |
| `reply_count` | **含楼中楼**（界面头部「评论 128」直接显示它）。顶层数由 §3.4 的 `count(*)` 现算 |
| `like_count` | 只统计 `value=1`（主题只有赞，拍板 §3） |
| `view_count` | bigint，走 counter 缓冲批量写回（§8.1），**不在请求里 UPDATE** |
| `last_reply_at` | 排序键，**NOT NULL**。建主题 = 1 楼 `created_at`；加回复 = 该回复 `created_at`；删回复 = 剩余最新回复的 `created_at`（§4.4）。**它是唯一能被回复推进的时间列**；`updated_at` 只被「编辑」推进（否则「最后编辑」会显示成「刚刚」，而作者根本没编辑） |

**两条状态轴的组合是合法的，不是矛盾**：`pending + normal` = 待审但未隐藏；`approved + deleted` = 过审后被作者删了。
「隐藏」和「拒绝」是两个动作，谁都不蕴含谁。（`盲审-数据库建模` 说旧设计「一列塞了三根轴」——现在已经是三根独立的轴：`visibility` / `review_state` / `locked_at`。）

**posts**

| 列 | 语义 |
|---|---|
| `floor` | 1 = 主题正文；`2..n` 按发帖顺序。`(topic_id, floor)` 唯一。**楼中楼也占一个 floor 号**，所以 floor 不连续是正常的 |
| `parent_id` | 楼中楼。**只允许一级**：父必须是 `parent_id IS NULL` 的顶层回复，且父与本行同一个 topic。校验位置在 service（§4.5），DB 上做不到（CHECK 不能跨行） |
| `visibility` | `normal` / `hidden` / `deleted`。**posts 上没有 review_state**：楼层可见性跟随主题（拍板 §2.2 第 3 条），存第二份必然漂移 |
| `content_md` / `content_html` | 原文 + goldmark→bluemonday 的结果（方案 §9.7）。**列表永远不读这两列** |

**topic_images 归 D5，本域不建这张表**（D5 `d5-content.md` §4.1：主键 `(topic_id, image_hash)` + `sort smallint CHECK (0..8)` + `uq_topic_images_sort`，写入端点是 `POST/DELETE /api/v1/topics/{id}/images`，handler 归 media）。

从本域借用的东西只有两样，**都在读路径上**：
1. 排序靠 `sort`，`sort = 0` 就是封面（D5 用唯一索引 `uq_topic_images_sort` 保证「封面是哪张」不是未定义），Q1 的封面 LATERAL 直接据此写；
2. 引用计数（`refcount`）由 D5 负责加减（「引用行在谁的表里，谁负责 ±1」——D5 §4.3 的原话），本域删主题时**只删 `topic_images` 行是做不到的**（那是 D5 的表），所以走 D5 的小接口（§9.4 的 `ImageRef`）。

**本设计刻意不引入 `post_id`**：那会让「同一张图能被挂到两层楼上」成立，从而把封面与排序规则复杂化一倍——而 1 楼是主题正文，成品里图片本来就是主题级的。如果要给「以后每条回复都能配图」留路，加的是 `post_id` 一列与一条迁移，而不是现在多一个概念。

**topic_sources**

| 列 | 语义 |
|---|---|
| `provider` | **开放小集合**：已知 13 个（旧站 `0005_sections_sources.sql` 的注释里就是这批），CHECK 收口。图标不存库，前端按 key 查（§7.3） |
| `label` | 作者写的显示名（「第三章整合包（含 18 张地图）」） |
| `url` | 外部直链。`CHECK (url ~ '^https?://')` 只兜住「不是 http(s)」，不做域名白名单（§7.2） |
| `extraction_code` | 网盘提取码，**明文存**（它是给所有人看的分享口令，不是密码）。可空 = 该源不需要 |
| `size_text` | 展示用「2.4 GB」。**后端格式化、后端存**：前端不做单位换算（`界面施工` §2.2 原文）。CHECK 约束形状，避免有人往里塞 HTML |
| `upkeep` | `active` / `archived`。**独立字段，不许从 `verified_at` 推断**（链接昨天验过、作者已弃坑是常见组合） |
| `go_count` | 转链点击数。**唯一走 counter 缓冲的计数列**（§8.2） |
| `verified_at` | 作者最后一次「我确认这条还有效」的时间 |

**post_issues**

| 列 | 语义 |
|---|---|
| `number` | 帖内编号（`#12`），`(topic_id, number)` 唯一，取号在创建事务里（§7.6）。**响应同时给 `id`（public_id）与 `number`**（`界面施工` §3.4） |
| `kind` | `bug` / `feature` / `difficulty` / `other`（四类，`界面施工` §3.2） |
| `status` | `keep_open` / `closed`。**牌面值就叫 `keep_open`**（拍板 §6 原文的 count 条件）；API 的 `?status=open|closed` 映射见 §7.8 |
| `assignee_id` | 指派给谁。`?assignee=me` 的落点（`界面施工` §3.1.2）；**不接受 `assignee=别人`**，否则它变成别人的筛选器 |
| `body_text` | 正文纯文本，供 `tsv` 生成列使用（D5 的 `PlainText`，与 `topic_search.body_text` 同一套道理） |
| `closed_at` 的 CHECK | `(status='closed') = (closed_at IS NOT NULL)`：关就有关闭时间，开着就没有——「谁关的、什么时候关的」不会缺失 |

**issue_comments**：与 posts 同构（`parent_id` 一级、`visibility`、两个计数列），不加 `number`（评论不需要编号）。

**likes**

| 列 | 语义 |
|---|---|
| `target_type` | `topic` / `post` / `issue` / `issue_comment`。**多态、无外键**（数据库文档 §4.3 的取舍保留：拆成两张表会把「切换赞」的规则写两遍——复盘根因 2） |
| `value` | `1` 赞 / `-1` 踩。**主题只允许 1**（服务层判，§5.1） |

**blocks**：`(user_id, target_user_id)` 主键，方向性明确（A 拉黑 B 不影响 B 看 A）。

**sanctions**

| 列 | 语义 |
|---|---|
| `board_id` | **NULL = 全站**，非空 = 只在该分区。这是拍板 §1.5 第 2 步「`board_id = 0` 或该分区」的真实表示（旧文档写 0，而 0 会被外键拒绝，所以用 NULL） |
| `action` | `post` / `reply` / `all`。发主题查 `action IN ('post','all')`，回复查 `action IN ('reply','all')` |
| `until` | NULL = 永久。**过期判定放在查询里，不放索引谓词**（拍板 §5.9 第 1 条：索引谓词必须 IMMUTABLE） |

---

## 3. 读路径：四条列表的完整游标 SQL 与索引对应

> 所有列表查询共用的两条常量（Go 侧拼 SQL 时引用它们，不复制字面量）：

```go
// internal/forum/repo.go —— 全域唯一的可见性条件
const liveTopicCond = `(t.visibility = 'normal' AND t.review_state = 'approved') OR t.author_id = $author`
const livePostCond  = `p.visibility = 'normal'`   // 楼层跟随主题，没有第二根轴
```

- `$author` 在**游客**时是 `0`（没有 id 为 0 的用户），在**登录者**时是 `actor.UserID`。用一个整数而不是「三个分支」把「作者能看见自己的待审帖」表达完。
- 列表 SQL **一律不带** `post.review` 的旁路：持审核权限的人看队列走 Q9，不需要在公开列表里混进待审内容。

### 3.1 查询 ↔ 索引对照表（**每个索引都要能回答它服务哪条查询**）

| # | 索引 | 服务哪条查询 | 为什么是这个列序 |
|---|---|---|---|
| a | `idx_topics_recent (last_reply_at DESC NULLS LAST, id DESC) WHERE visibility='normal'` | 首页默认流 §3.2-Q1 | 排序键逐字同序（拍板 §5.9 第 4 条）；部分索引把 hidden/deleted 挡在索引外 |
| b | `idx_topics_board_live (board_id, last_reply_at DESC NULLS LAST, id DESC) WHERE visibility='normal'` | 分区页默认流 §3.3-Q2a | 等值列在前、排序键在后——这才是能同时吃 `board_id=$1` 与游标的形状 |
| c | `idx_topics_board_new (board_id, created_at DESC, id DESC) WHERE visibility='normal'` | 分区页 `sort=new`、首页 `?board=&sort=new` | 同上，换排序键 |
| d | `idx_topics_kind_new (kind, created_at DESC, id DESC) WHERE visibility='normal'` | 分区页/首页的「资源」标签 | `kind` 是低基数列，但它与 `created_at` 在一起时「资源帖最新」从「扫全站再过滤」变成「扫几十行」 |
| e | `idx_topics_author (author_id, created_at DESC, id DESC)` | 个人主页 §3.5-Q4a；分区页「我的主题」递归 CTE 的锚点 | 用户主页固定按 `created_at` 排。**不能是部分索引**：作者要看见自己的 pending/rejected |
| f | `idx_topics_featured (featured_at DESC, id DESC) WHERE visibility='normal' AND featured_at IS NOT NULL` | 分区页「精华」标签 §3.3-Q2c | 部分索引把候选压到几十行；没有它这条查询要扫整个分区 |
| g | `idx_topics_pinned (board_id, pinned_at DESC, id DESC) WHERE visibility='normal' AND pinned_at IS NOT NULL` | 置顶区块 §3.3-Q2b | 每分区 ≤5 行，索引小到可以常驻内存 |
| h | `idx_topics_review_queue (review_state, created_at DESC, id DESC) WHERE review_state <> 'approved'` | 管理端审核队列 §3.7-Q9 | 部分索引把 99.9% 的已过审行排除在索引外，索引大小与「待审量」成正比 |
| h2 | `idx_topics_board_id (board_id)` | **无查询**——只为 `board_id` 的外键路径存在 | 同列上的部分索引用不了引用完整性查找（数据库文档 §12 第 1 条的 `indpred IS NULL`） |
| i | `idx_posts_topic_id (topic_id, id)` | 顶层回复 §3.4-Q3a；计数重算 §3.7-Q8 | 帖内所有楼层，按 id 游标（楼层 id 与 floor 同序） |
| j | `idx_posts_parent (parent_id)` | 楼中楼 §3.4-Q3b；顶层回复的 `reply_total`；外键检查 | `parent_id` 上的**普通**索引（不能是部分索引：引用完整性查找用不了带谓词的索引） |
| k | `idx_bookmarks_user (user_id, created_at DESC, id DESC)` | 收藏页 §3.6-Q5 | 主键 `(user_id, topic_id)` 的列序不能服务 `ORDER BY created_at DESC` |
| l | `uq_likes_user_target (user_id, target_type, target_id)` | 投票幂等 §5.1；取 `my_vote` §3.4-Q3a | 唯一约束即索引 |
| m | `idx_likes_target (target_type, target_id)` | 计数 §5.2、批量取我的票 §5.3、孤儿自检 §11.2 | 多态表没有外键，`target_id` 上的索引必须自己建（拍板 §5.9 第 5 条） |
| n | `idx_post_issues_global (status, updated_at DESC, id DESC)` | 全站 Issue 聚合 §7.7 | 等值 `status` 在前，排序键在后 |
| o | `idx_post_issues_topic_status (topic_id, status, updated_at DESC, id DESC)` | topic 详情的 `issue_open_count`（前缀 `(topic_id,status)`）；单帖 Issue 列表 | 拍板 §6 最后一行指定的形状 |
| p | `idx_sanctions_user (user_id, until)` | 发言前判定 §6.3 | `until` 只用来读，不用来做索引谓词 |

**写放大记账**：`topics` 上 8 个索引里 6 个是部分索引，实际索引的行数分别只有「全站的 normal 主题」「某分区的 normal 主题」量级。
其中 `idx_topics_board_id` **不是给查询用的**——它是外键索引检查（§11.1 第 1 条）要求的：`idx_topics_board_live` / `idx_topics_board_new` 带谓词，
**引用完整性查找用不了部分索引**，删分区时会全表扫（`idx_topics_pinned` 的 `board_id` 前缀也救不了，因为它自己也是部分索引）。
这条的存在理由必须写进迁移注释，否则下一个人会当成重复索引删掉。

**三个「历史记录列」刻意没有外键**：`topics.reviewed_by`、`post_issues.closed_by`、`sanctions.created_by` 都是 `bigint NULL` 且**不引用 users**。
理由：`users` 永不硬删（数据库文档 §2.11），外键给不出任何保证，却各自要多养一个只为「删用户路径」存在的索引——而这三个索引没有任何查询会用到。

**另一处刻意留白的覆盖**：`boards.cover_hash`（→ `images.hash`）也没有左前缀索引。理由是删图片这条路径在这套设计里**不存在**：图片是内容寻址且**永不物理删除行**，`image:gc` 只删 `refcount = 0` 的文件字节（D5 §2.2），所以 `ON DELETE SET NULL` 永远不会被触发；而 `GET /boards` 只按 `sort` 扫描十几行。**唯一有覆盖缺口的只剩它，§11.1 第 1 条的外键索引检查要对它放行，放行名单必须写成一条显式的白名单并附上这句话**，否则下一个人分不清「故意」与「漏了」。
这与 `audit_logs.actor_id` 是同一条取舍。代价：这三列可能出现指向不存在用户的值，**读的时候按需 JOIN users，取不到就显示「已注销」**，而不是靠外键拦住写入。

### 3.2 首页列表 `GET /api/v1/topics`（无 board）

```sql
-- Q1：首页默认流（sort=latest）
SELECT t.id, t.public_id, t.kind, t.title, t.excerpt, t.pinned_at, t.featured_at,
       t.reply_count, t.like_count, t.view_count, t.last_reply_at, t.created_at,
       b.slug AS board_slug, b.name AS board_name,
       a.public_id AS author_public_id, a.username AS author_handle,
       a.nickname AS author_nickname, a.avatar_hash, a.avatar_small_hash,
       ci.image_hash AS cover_hash, ci.width AS cover_width, ci.height AS cover_height
  FROM topics t
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = t.author_id
  LEFT JOIN LATERAL (
    SELECT i.hash, i.width, i.height          -- 封面 = sort 0 的那张（D5 §4.1：uq_topic_images_sort 保证唯一）
      FROM topic_images ti JOIN images i ON i.hash = ti.image_hash
     WHERE ti.topic_id = t.id AND ti.sort = 0
  ) ci ON true
 WHERE t.visibility = 'normal'
   AND t.review_state = 'approved'
   AND ($1::bigint IS NULL OR t.board_id = $1)
   AND ($2::text   IS NULL OR t.kind = $2)
   AND (t.last_reply_at, t.id) < ($3::timestamptz, $4::bigint)
 ORDER BY t.last_reply_at DESC NULLS LAST, t.id DESC
 LIMIT $5;
```

- **`(k,id) < (?,?)` 就是游标**，`$3/$4` 来自 `base64url(JSON{"k":<排序键>,"id":<bigint>})`。
  **第一页传 `'infinity'::timestamptz` 与 `9223372036854775807`，不是 NULL**：行比较里的 NULL 会让整条谓词变 NULL，即静默返回零行——这是 keyset 分页最容易写错的一处。
- 索引 **(a)**。EXPLAIN 必须看到 `Limit` 直接压在 `Index Scan using idx_topics_recent` 上，且 `Index Cond` 里出现 `ROW(last_reply_at, id) < ROW($3, $4)`。
  出现 `Seq Scan` 或 `Sort` 就是索引列序/`NULLS LAST` 写错了（§11.1 第 11 条会红）。
- LATERAL 只对**最终返回的那 20 行**执行（Nested Loop 是「取一行、补一行」，Limit 在上方），所以「取封面」不会变成 20 次全表扫；`sort = 0` 走 `uq_topic_images_sort` 的等值查找。
- **`sort=new`**：把排序键换成 `(t.created_at DESC, t.id DESC)`、游标换成 `(created_at,id)`、`ORDER BY` 一起换。此时前端应带 `?board=` 走索引 (c)；
  **不带 board 的纯 `sort=new` 没有专属索引**（走 (a) 反向扫 + Sort）。这是刻意接受的：首页「最新」流是低频路径，为一个低访问量的排序再养一个部分索引不值。
- **`sort` 白名单在 Go 里**：`map[string]string{"latest": "t.last_reply_at", "new": "t.created_at"}`，拼进 SQL 的只有这两列之一（**永远不拼用户输入**）。
- **判重**：`(k,id)` 是行比较，`k` 并列时由 `id` 兜底，所以并列不会跨页重复/漏项（拍板 §5.1）。
- **`?q=` 搜索不走这条查询**：搜索由 D5 的 `topic_search` 负责，本域只接「按 id 批量补全」（D5 §6.4 的「结果补全」）。列表查询里的 `q` 参数一律忽略或返回 400，**不允许出现第二条模糊匹配路径**。

### 3.3 分区页 `GET /api/v1/topics?board=<slug>`

分区页有三块内容，**三块各一条查询**：它们走不同索引，硬塞成一条会让优化器只有一个计划可选。

```sql
-- Q2a：分区列表默认流 = Q1 的 SQL + 把 $1 换成分区 id（走索引 (b)）
-- Q2c：精华标签
SELECT t.id, t.public_id, t.kind, t.title, t.excerpt, t.featured_at,
       t.reply_count, t.like_count, t.view_count, t.last_reply_at, t.created_at
  FROM topics t
 WHERE t.board_id = $1
   AND t.visibility = 'normal' AND t.review_state = 'approved'
   AND t.featured_at IS NOT NULL
   AND (t.featured_at, t.id) < ($2::timestamptz, $3::bigint)
 ORDER BY t.featured_at DESC, t.id DESC
 LIMIT $4;
-- 索引 (f)。部分索引已含 featured_at IS NOT NULL，WHERE 里再写一次是冗余但等价的，保留它让意图一眼可读。

-- Q2d：类型标签（资源 / 讨论 / 转载）：= Q1 的 SQL + board_id + kind，排序键换 (created_at, id)，走索引 (d)
```

```sql
-- Q2b：置顶区块（单独一条，不进游标、不翻页）
SELECT t.id, t.public_id, t.title, t.kind, t.locked_at, t.pinned_at
  FROM topics t
 WHERE t.board_id = $1 AND t.visibility = 'normal' AND t.pinned_at IS NOT NULL
 ORDER BY t.pinned_at DESC, t.id DESC
 LIMIT 5;
-- 索引 (g)。5 行以内，前端钉在列表上方，翻页时不变。
```

```sql
-- Q2e：分区统计（分区详情一次拿全；三个数都是索引现算，没有计数列）
SELECT b.id, b.slug, b.name, b.description, b.sort, b.status, b.cover_hash,
       b.acl_enabled, b.min_post_level,
       live.topic_count, live.post_count, live.today_count
  FROM boards b
  LEFT JOIN LATERAL (
    SELECT count(*)                                   AS topic_count,
           coalesce(sum(t.reply_count), 0)            AS post_count,
           count(*) FILTER (WHERE t.created_at >= $1) AS today_count
      FROM topics t
     WHERE t.board_id = b.id AND t.visibility = 'normal' AND t.review_state = 'approved'
  ) live ON true
 WHERE ($2::bigint IS NULL OR b.id = $2)
   AND b.status = 'active'
 ORDER BY b.sort, b.id;
-- $1 = 今日零点，服务端按站点时区算好再传；不要在 SQL 里用 now() + date_trunc —— 那是第二处时区实现。
-- 索引 (b)：Index Only Scan，count(*) 只读索引不读堆。分区的典型值是几十毫秒；
--   闸门见 §11.1 第 12 条（单分区主题数 > 5 万时告警，那时才谈计数列）。
-- post_count 用 sum(reply_count) 而不是 count(posts)：后者要扫 posts 在每个分区的索引范围（几万行），
--   前者只是 topics 行上的整数相加。reply_count 的定义就是「回复楼层数」，所以它就是分区里的回复总数。
```

### 3.4 回复列表与楼中楼 `GET /api/v1/topics/{id}/posts`

```sql
-- Q3a：顶层回复（游标分页）＋ 每条顶层回复的 3 条楼中楼预览 ＋ 我的投票 —— 一次往返
WITH roots AS (
  SELECT p.id, p.public_id, p.author_id, p.floor, p.content_html,
         p.like_count, p.dislike_count, p.created_at, p.updated_at,
         (SELECT count(*) FROM posts r
           WHERE r.parent_id = p.id AND r.visibility = 'normal') AS reply_total
    FROM posts p
   WHERE p.topic_id = $1
     AND p.parent_id IS NULL
     AND (p.visibility = 'normal' OR p.author_id = $2)
     AND p.id < $3::bigint
   ORDER BY p.id DESC
   LIMIT $4
)
SELECT r.id, r.public_id, r.floor, r.content_html, r.like_count, r.dislike_count,
       r.created_at, r.updated_at, r.reply_total,
       a.public_id AS author_public_id, a.username AS author_handle,
       a.nickname AS author_nickname, a.avatar_hash, a.avatar_small_hash,
       COALESCE(preview.ids, ARRAY[]::uuid[]) AS preview_ids,
       my.value AS my_vote
  FROM roots r
  JOIN users a ON a.id = r.author_id
  LEFT JOIN LATERAL (
    SELECT array_agg(x.public_id ORDER BY x.id) AS ids
      FROM (SELECT q.id, q.public_id FROM posts q
             WHERE q.parent_id = r.id AND q.visibility = 'normal'
             ORDER BY q.id LIMIT 3) x
  ) preview ON true
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'post' AND my.target_id = r.id
 ORDER BY r.id DESC
```

```
$1 = topic_id，$2 = 当前用户 id（游客传 0），$3 = 游标（第一页传 9223372036854775807），$4 = limit
索引 (i) idx_posts_topic_id (topic_id, id)：topic_id 等值 + id 范围 + parent_id 过滤。
顶层回复只占帖子全部楼层的一小部分，翻几页也只扫几百到几千行 → Filter 成本可忽略。
若 EXPLAIN 出现「Rows Removed by Filter」远大于返回行（大帖里楼中楼占九成），加：
  CREATE INDEX idx_posts_roots ON posts (topic_id, id) WHERE parent_id IS NULL;   ← 【未决 12.3-3】
```

- **`my_vote` 与预览都在这条 SQL 里，没有 N+1**：一次 `LATERAL` 拿 3 条预览的 public_id，一次 `LEFT JOIN likes` 拿我自己的票。
- 游客的 `$2 = 0`：`likes` 上没有 user_id = 0 的行，`LEFT JOIN` 必然补 NULL → `my_vote = 0`（拍板 §3：游客恒为 0）。
- **预览只给 public_id 数组**：楼中楼的正文由前端在「展开」时另请求（Q3b）。把 100 条楼中楼的正文塞进顶层分页响应是另一种浪费。
  前端拿到 `preview_ids` 后**不重新排序**，按数组顺序展示；`reply_total` 直接渲染成「查看全部 N 条回复」。
- `reply_total` 是相关子查询 `count(*) WHERE parent_id = p.id`：走索引 (j)，每条顶层一次索引查找，上限 = limit 次（20 次）。
- **只显示 `visibility='normal'` 的楼层**，一个例外：**作者本人能看见自己被隐藏/软删的楼层**（他自己得知道自己删了什么）。
  主题被隐藏/软删时本端点整条拒绝（`404 topic.not_found`，见 §4.6），**不在楼层上再判一次主题状态**。

```sql
-- Q3b：某个顶层回复的楼中楼（展开「查看全部 N 条回复」）
SELECT p.id, p.public_id, p.author_id, p.content_html, p.like_count, p.dislike_count,
       p.created_at, p.updated_at,
       a.public_id AS author_public_id, a.username AS author_handle,
       a.nickname AS author_nickname, a.avatar_hash, a.avatar_small_hash,
       my.value AS my_vote
  FROM posts p
  JOIN users a ON a.id = p.author_id
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'post' AND my.target_id = p.id
 WHERE p.parent_id = $1 AND p.visibility = 'normal'
 ORDER BY p.id
 LIMIT 200;
-- 索引 (j) idx_posts_parent。一级楼中楼，200 条是硬上限（超出说明该帖该改「查看更多」了）
```

**为什么回复列表按 `id` 倒序、而不是按 `created_at`**：`id` 是 identity，与 `created_at` 同序，但它是**单列**——游标只装一个整数，
不用装时间戳；而 `created_at` 由 `now()` 写入，同一毫秒内两条回复会出现真并列（identity 不会）。
**楼层顺序与「最新回复」顺序在这里是同一个顺序**，不存在两个真源。
（`@/ui/comment` 的「最热 / 最新」两个按钮是**同一页数据的前端排序**，`comment-list.tsx` 里就是 `useState`；后端不做 `?sort=hot`——见 §12.3-5。）

### 3.5 个人主页 `GET /api/v1/users/{handle}/topics`

个人主页有两种浏览方式，**语义不同，两条 SQL**：

```sql
-- Q4a：直接翻页（游标 + 索引，无 CTE）—— 默认路径
SELECT t.id, t.public_id, t.title, t.excerpt, t.kind, t.reply_count, t.like_count,
       t.view_count, t.last_reply_at, t.created_at, t.visibility, t.review_state,
       b.slug AS board_slug, b.name AS board_name
  FROM topics t
  JOIN boards b ON b.id = t.board_id
 WHERE t.author_id = $1
   AND (t.visibility = 'normal' OR t.author_id = $2)
   AND (t.created_at, t.id) < ($3::timestamptz, $4::bigint)
 ORDER BY t.created_at DESC, t.id DESC
 LIMIT $5;
-- 索引 (e) idx_topics_author (author_id, created_at DESC, id DESC)。
-- $2 = 当前用户 id（游客传 0）：看自己时 pending/rejected/hidden/deleted 都返回，看别人时只剩 normal。
-- 排序键是 created_at 而不是 last_reply_at：主页按发帖时间倒序，
--   谁也不想看到「我三年前发的帖因为昨天被人回了一句而排到第一」。
-- 注意这里**没有 review_state 条件**：作者看得见自己的 pending/rejected（拍板 §2.2 第 2 条的"作者本人可见"）。
```

```sql
-- Q4b：分区页的「我的主题」= 沿分区一跳的图遍历
WITH RECURSIVE reach AS (
    SELECT t.id, t.board_id, t.created_at, 0 AS depth
      FROM topics t
     WHERE t.author_id = $1
    UNION
    SELECT n.id, n.board_id, n.created_at, r.depth + 1
      FROM reach r
      JOIN topics n ON n.board_id = r.board_id
     WHERE r.depth < 1
       AND n.visibility = 'normal' AND n.review_state = 'approved'
) SEARCH DEPTH FIRST BY id SET ord
SELECT t.id, t.public_id, t.title, t.excerpt, t.kind, t.reply_count, t.like_count,
       t.view_count, t.last_reply_at, t.created_at, r.depth,
       b.slug AS board_slug, b.name AS board_name
  FROM reach r
  JOIN topics t ON t.id = r.id
  JOIN boards b ON b.id = t.board_id
 WHERE (t.created_at, t.id) < ($3::timestamptz, $4::bigint)
 ORDER BY t.created_at DESC, t.id DESC
 LIMIT $5;
-- 锚点走索引 (e)（author_id 等值）；递归项走索引 (b)/(c)（board_id 等值 + id 范围）。
-- 深度写死 1（r.depth < 1）：这是「同一个分区」而不是「全站扩散」。深度每加 1，结果集按分区分支因子膨胀。
-- SEARCH DEPTH FIRST BY id SET ord 只是给行一个遍历序，不参与最终排序（最终排序仍是 created_at DESC, id DESC）。
```

> **为什么这条用递归 CTE 而不是两条 SQL 在应用层拼**：需求本身是「**沿分区关系走一跳**」——
> 「我发过主题的分区」→「那个分区里的主题」。两条 SQL 拼（先取 `board_id` 集合，再用 `IN` 查第二段）等价，
> 但会让**同一个游标要在两段结果之间手工合并**，那才是真正会写错的地方。SQL 侧一跳的成本是锚点集合的一倍，换来的是游标语义只有一套。
> 实测基准与替代写法（`EXISTS` 半连接）见 §11.3；若基准显示明显更慢，替代不改变端点契约。

### 3.6 收藏页 `GET /api/v1/me/bookmarks`

```sql
-- Q5：我收藏的帖子，按收藏时间倒序（不是按发帖时间——收藏夹里最近收的最该在上面）
SELECT t.id, t.public_id, t.title, t.excerpt, t.kind, t.reply_count, t.like_count,
       t.view_count, t.last_reply_at, t.created_at, t.visibility, t.review_state,
       bk.created_at AS bookmarked_at,
       b.slug AS board_slug, b.name AS board_name,
       a.public_id AS author_public_id, a.username AS author_handle,
       a.nickname AS author_nickname, a.avatar_hash, a.avatar_small_hash
  FROM bookmarks bk
  JOIN topics t ON t.id = bk.topic_id
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = t.author_id
 WHERE bk.user_id = $1
   AND (bk.created_at, bk.topic_id) < ($2::timestamptz, $3::bigint)
   AND (t.visibility = 'normal' OR t.author_id = $1)
 ORDER BY bk.created_at DESC, bk.topic_id DESC
 LIMIT $4;
-- 索引 (k) idx_bookmarks_user (user_id, created_at DESC, id DESC)：user_id 等值 + 游标逐字同序。
-- 这里的 (k,id) 就是 (bookmarks.created_at, bookmarks.topic_id)——主键 (user_id, topic_id) 保证 topic_id 唯一。
-- 需要 requireLogin；游客不可达。
```

**收藏夹里不可见的帖怎么办**：`(t.visibility='normal' OR t.author_id=$1)` 的效果是——
自己作者被隐藏/软删的帖仍然列出（前端置灰、点不进去），别人的不可见帖直接不出现。
留一堆点不开的灰卡比少几行更糟，所以**不做「未读的收藏已失效」这类提示**。

### 3.7 详情与其它读路径（同一套过滤，不走游标）

```sql
-- Q6：主题详情（一次拿全：主题 + 作者 + 分区 + 我是否收藏 + 我的投票 + issue 未关闭数）
SELECT t.id, t.public_id, t.board_id, t.author_id,
       t.kind, t.title, t.visibility, t.review_state, t.review_note,
       t.locked_at, t.pinned_at, t.featured_at, t.resource_status,
       t.reply_count, t.like_count, t.view_count, t.last_reply_at, t.created_at, t.updated_at,
       b.slug AS board_slug, b.name AS board_name, b.acl_enabled, b.min_post_level,
       a.public_id AS author_public_id, a.username AS author_handle,
       a.nickname AS author_nickname, a.avatar_hash, a.avatar_small_hash,
       (SELECT count(*) FROM post_issues i
         WHERE i.topic_id = t.id AND i.status = 'keep_open')              AS issue_open_count,
       (SELECT l.value FROM likes l
         WHERE l.user_id = $2 AND l.target_type = 'topic' AND l.target_id = t.id) AS my_vote,
       EXISTS (SELECT 1 FROM bookmarks bk
                WHERE bk.user_id = $2 AND bk.topic_id = t.id)             AS bookmarked
  FROM topics t
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = t.author_id
 WHERE t.id = $1
   AND ( (t.visibility = 'normal' AND t.review_state = 'approved')
         OR t.author_id = $2
         OR $3::boolean );                -- $3 = 调用者持 post.review
-- issue_open_count：走索引 (o) 的 (topic_id, status) 前缀（拍板 §6 最后一行：不加冗余列）
-- my_vote / bookmarked：$2 = 0（游客）时两次索引查找、必然 0 行；不为游客省这一步，多一个分支就多一处漏判。
-- $3 只在管理端审核详情时为 true；公开详情恒 false。
```

```sql
-- Q7a：主题正文（1 楼）
SELECT p.id, p.public_id, p.floor, p.content_md, p.content_html,
       p.like_count, p.dislike_count, p.visibility, p.created_at, p.updated_at,
       (SELECT count(*) FROM posts r WHERE r.parent_id = p.id AND r.visibility = 'normal') AS reply_total,
       (SELECT count(*) FROM post_issues i WHERE i.topic_id = p.topic_id)                   AS issue_total
  FROM posts p
 WHERE p.topic_id = $1 AND p.floor = 1;
-- 走 uq_posts_topic_floor (topic_id, floor)，唯一命中。
-- 1 楼被软删时这一行仍然返回（floor 不会消失，前端渲染成「该主题正文已被作者删除」），
--   主题标题仍在 topic 行上——这就是「正文删了标题还在」的实现方式。

-- Q7b：帖子配图（封面之外的图集）—— 表归 D5，形状见 d5-content.md §4.1
SELECT ti.image_hash, ti.sort, i.width, i.height, i.size, i.mime
  FROM topic_images ti JOIN images i ON i.hash = ti.image_hash
 WHERE ti.topic_id = $1
 ORDER BY ti.sort;
-- 走主键前缀 (topic_id) 后按 sort 排序；每帖 ≤ 9 行（D5 的 sort CHECK 0..8 与这条上限是同一个事实）。

-- Q7c：下载源列表
SELECT s.id, s.public_id, s.provider, s.label, s.url, s.extraction_code,
       s.size_text, s.upkeep, s.go_count, s.verified_at, s.sort
  FROM topic_sources s
 WHERE s.topic_id = $1
 ORDER BY s.sort, s.id;
-- 走索引 idx_topic_sources_topic (topic_id, sort, id)。
-- extraction_code 无条件返回：它是分享口令不是密码，而且转链端点本来就是给游客点的（§7.2）；
--   想不公开它就不要填。前端在未填时按 provider 给「无需提取码」。
```

```sql
-- Q8a：计数重算（发/删回复、删主题时，在同一事务里重算而不是增量加）
SELECT count(*) FILTER (WHERE floor > 1 AND visibility = 'normal') AS reply_count
  FROM posts WHERE topic_id = $1;
-- 走索引 (i)。帖内楼层数有上限（几千），全范围扫一次是毫秒级。
-- **刻意不用 reply_count = reply_count + 1**：增量加要在「删回复、删主题、隐藏回复、管理员删楼」四条路径上各写一遍补偿，
--   一处漏写就永久漂移；重算只有一处，且天然收敛。付出的是每次发帖多扫一次该主题的楼层索引。

-- Q8b：删回复后重算 last_reply_at
SELECT max(created_at) FROM posts WHERE topic_id = $1 AND visibility = 'normal';
-- 同上走索引 (i)。$1 的帖子里必然至少有 1 楼（floor=1 不会物理删除），所以结果非空，last_reply_at 的 NOT NULL 不被破坏。
```

```sql
-- Q9：审核队列（管理端；权限点 post.review）
SELECT t.id, t.public_id, t.title, t.kind, t.review_state, t.visibility, t.review_note,
       t.created_at, t.reviewed_at,
       b.slug AS board_slug,
       a.public_id AS author_public_id, a.username AS author_handle,
       a.nickname AS author_nickname, a.trusted
  FROM topics t
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = t.author_id
 WHERE t.review_state = $1                     -- pending / rejected
   AND ($2::bigint IS NULL OR t.board_id = $2)
   AND (t.created_at, t.id) < ($3::timestamptz, $4::bigint)
 ORDER BY t.created_at DESC, t.id DESC
 LIMIT $5;
-- 索引 (h)：部分索引把已过审的行排除在索引外，索引大小与「待审量」成正比，与全站主题数无关。
```

### 3.8 游标编解码（一处实现，全域共用）

```go
// internal/forum/cursor.go
type cursor struct {
    K  string `json:"k"`    // 排序键的字符串形式；时间用 RFC3339Nano，整数用十进制，浮点用 math.Float32bits 的十进制
    ID int64  `json:"id"`   // **内部 bigint**，不是 public_id：游标要在服务的 WHERE 里直接比较，用 public_id 就得回查一行
}

func encodeCursor(k string, id int64) string        // base64url(JSON) 
func decodeCursor(s string) (cursor, error)         // 解不开 → 400 common.invalid_input
func parseTime(s string) (time.Time, error)         // 空串 → time.Time{}，由调用方转成 infinity（见下）
```

**三条必须一起做对的规则**：

1. **`k` 是字符串**，不是 `any`。JSON 数字在 float64 与 int64 之间会丢精度（bigint 主题 id 早过了 2^53），而 RFC3339 又不能反序列化成数字——统一成字符串，各类型自己编码。
2. **第一页用一个哨兵**：`$3/$4` 传 `time.Time{}` 的零值 → 拼成 `'infinity'::timestamptz` 与 `math.MaxInt64`。**禁止传 NULL**（行比较遇 NULL 整条为 NULL，会静默返回零行）。
3. **`next_cursor` 只在 `len(rows) == limit` 时给出**：少于 limit 就是到底（响应 `next_cursor: null`）。多查一行来精确判断到底也可以，但它多一次「丢最后一行」的机会，不值得。

**为什么游标里装内部 id 而不是 public_id**：拍板 §5.1 的 `(k,id)` 里的 id 是**用来比大小的**。public_id 是 UUIDv7，可比较，但每次翻页都要多一次「按 public_id 找回 bigint」，
而这次查找落在哪条索引上取决于排序列——一个纯粹为了好看而引入的额外查询。游标是**服务端自己发给自己**的不透明串，不是 API 契约的一部分（前端只做透传），所以装 bigint 没有暴露面。
**唯一要守的纪律**：游标里的 id 永远不出现在响应里（响应里只有 public_id），这样「禁止把自增 id 返给前端」仍然成立。

### 3.9 索引清单（与 §2.1 的 DDL 一一对应）

| 表 | 索引 | 类型 | 服务查询 |
|---|---|---|---|
| boards | `idx_boards_sort` | 普通 | §3.3 Q2e 分区列表与切换器 |
| board_acls | 主键 `(board_id, role_id)` | 唯一 | §6.2 ACL 判定（`board_id` 前缀） |
| board_acls | `idx_board_acls_role` | 普通 | `role_id` 的外键路径（删角色） |
| board_moderators | 主键 `(board_id, user_id)` | 唯一 | §6.3 版主判定按 board 查；`board_id` 前缀覆盖外键 |
| board_moderators | `idx_board_moderators_user` | 普通 | 登录装配 `Actor.BoardIDs`（D2 §8.3）+ `user_id` 外键路径 |
| topics | (a)–(h) 见 §3.1 | 5 部分 + 1 唯一部分 + 2 普通 | 见 §3.1 |
| posts | `uq_posts_topic_floor` | 唯一 | Q7a 取 1 楼；§4.2 发帖分配 floor |
| posts | `idx_posts_topic_id` | 普通 | Q3a 顶层回复；Q8 计数重算 |
| posts | `idx_posts_author` | 普通 | 外键检查（删用户路径）；「我发过的回复」暂无端点（§12.3-4） |
| posts | `idx_posts_parent` | 普通 | Q3a 的 `reply_total`、Q3b 楼中楼、外键检查 |
| posts | `idx_posts_author_client_token` | 唯一部分 | §4.3 幂等 |
| topic_images | **归 D5**：主键 `(topic_id, image_hash)` + `uq_topic_images_sort` + `idx_topic_images_hash` | 唯一 | 封面（§3.2 的 LATERAL，`sort = 0`）、Q7b 图集 |
| topic_sources | `idx_topic_sources_topic` | 普通 | Q7c 下载源列表 |
| post_issues | `uq_post_issues_topic_number` | 唯一 | §7.6 取号；#号跳转 |
| post_issues | `idx_post_issues_global` | 普通 | §7.7 全站聚合 |
| post_issues | `idx_post_issues_topic_status` | 普通 | Q6 的 `issue_open_count`（前缀）+ 单帖列表 |
| post_issues | `idx_post_issues_author` | 普通 | §7.7 `?author=` + 外键检查 |
| post_issues | `idx_post_issues_assignee` | 部分 | §7.7 `?assignee=me`。**故意是部分索引**：`assignee_id` 的外键查找用不了它，但已指派的 issue 只占极小一部分，为「删用户」建全量索引不值得（删用户在这套系统里不会发生） |
| post_issues | `uq_post_issues_author_client_token` | 唯一部分 | §4.3 幂等 |
| issue_comments | `idx_issue_comments_issue` | 普通 | §7.8 评论列表（id 游标） |
| issue_comments | `idx_issue_comments_author` / `idx_issue_comments_parent` | 普通 | 外键检查（删作者 / 删父评论路径） |
| likes | `uq_likes_user_target` | 唯一 | §5.1 幂等 + Q3a 取 `my_vote` |
| likes | `idx_likes_target` | 普通 | §5.2 计数、§5.3 批量取我的票、§11.2 孤儿检查 |
| bookmarks | `idx_bookmarks_user` | 普通 | Q5 收藏页 |
| bookmarks | `idx_bookmarks_topic` | 普通 | `topic_id` 的外键路径（级联删主题；主键第二列不算已索引） |
| blocks | `idx_blocks_target` | 普通 | 外键检查（`target_user_id` 的级联删除路径） |
| sanctions | `idx_sanctions_user` | 普通 | §6.3 发言前判定 |
| sanctions | `idx_sanctions_board` | 普通 | 管理端按分区列出禁言 + 外键检查 |

**没有 `likes(target_id)` 单列索引、没有 `topics(created_at)` 单列索引、没有 `posts(topic_id, created_at)`**：
它们服务的查询已经被上面的复合索引前缀覆盖，再建就是重复索引（数据库文档 §12 第 10 条会红）。

---

## 4. 写路径

### 4.1 一次写请求的判定顺序（**照这个顺序写，不要各判各的**）

```
handler : 解析 body → 取 actor（auth.FromGin）→ 调 service
service :
  0. authz.Require(actor, perm)                 // 全局权限点：topic.create / topic.edit.own / …
  1. 归属判定（仅"改/删自己的"类）                // topic.AuthorID == actor.UserID，或有 topic.delete.any 直接过
  2. 读行并判可见性 + 锁定                       // 主题不存在/不可见 → 404；locked_at 非空 → 403 topic.locked
       └ 顺序刻意如此：先回答"你看不看得见这一行"，再回答"你能不能对它做这件事"。
         反过来的话，对一篇被隐藏的主题回 403 就等于承认"它存在"。
  3. 目标状态合法性                              // 已删除 → 404；已置顶再置顶 → 幂等成功（不是 409）
  4. 发言权（只在"新增内容"类写路径上判，见 §4.1.1）  // 禁言 → ACL → 发帖门槛 → 拉黑
  5. 业务写入（事务）
```

**第 4 步只在发主题 / 发回复 / 发 issue / 发 issue 评论 / 传配图这五条路径上执行。**
编辑、删除、锁定、置顶、收藏、投票都不判发言权——被禁言的人当然要能删掉自己那条违规内容。

#### 4.1.1 发言权判定的准确顺序（拍板 §1.5 的 6 步 → 本域的落地）

```go
// internal/forum/acl.go —— 发帖与回复共用这一个函数
// action: "post" | "reply"
func (s *Service) canSpeak(ctx context.Context, actor *authz.Actor, boardID int64, action string) error {
    // 1. 超管放行
    if actor != nil && actor.IsSuper { return nil }
    // 2. 未过期禁言（board_id IS NULL 或 = 本分区）；命中的最早一条决定 until
    if until, err := s.repo.ActiveSanction(ctx, actor.UserID, boardID, action); err != nil { return err } else if until != nil {
        return sanctionErr(*until)          // 403 forum.sanctioned，msg 带到期时间
    }
    // 3. 分区没开 ACL：登录即可发言（还要过 3.5 的等级门槛）
    row, err := s.repo.BoardACLRow(ctx, boardID, actor.RoleID, actor.UserID)   // 一条 SQL，见 §6.2
    if err != nil { return err }
    if !row.ACLEnabled { return s.checkMinLevel(ctx, actor, boardID, action) }
    // 4. 禁止优先：基线角色那一行 deny_* → 拒绝（追加权限也能 deny，见 §6.2 的"只有 deny 能追加"）
    if row.Deny(action) { return ErrForbidden }                  // 403 board.acl_denied
    // 5. 同一行 can_* → 放行（仍要过等级门槛）
    if row.Can(action)  { return s.checkMinLevel(ctx, actor, boardID, action) }
    // 6. 该分区没有任何该角色的行 → 拒绝（白名单制）
    return ErrForbidden                                              // 403 board.acl_denied
}
```

**拉黑（blocks）不在这六步里**，它排在第 5 步的业务写入之前、且**只作用于"回复别人的主题"和"在楼中楼里回某个人"**：

```sql
-- 拉黑判定（写回复前，一次两行）
SELECT
  EXISTS (SELECT 1 FROM blocks WHERE user_id = $1 AND target_user_id = $2) AS i_blocked_them,
  EXISTS (SELECT 1 FROM blocks WHERE user_id = $2 AND target_user_id = $1) AS they_blocked_me;
-- $1 = 我，$2 = 主题作者（回复主题时）或父楼作者（楼中楼时）
-- 双向任一命中 → 403 forum.blocked。**不告诉他是谁拉黑了谁**（D4 §5.2 同一条口径）。
-- 走 blocks 主键 (user_id, target_user_id) 与 idx_blocks_target (target_user_id)，各一次索引查找。
-- 注意：只有"回复对方的内容"才判。**作者不能拉黑访客，访客也不该因为被作者拉黑而看不到主题**——
--   拉黑是"别再跟我说话"，不是"别看我的帖"。
```

**中段/末段为什么是这个顺序**：

| 顺序 | 为什么不能挪 |
|---|---|
| 禁言在 ACL 之前 | 禁言是「这个人现在不许说话」，比「这个角色在这个分区能不能说话」更高优先；而且被禁言者拿到的应该是 `forum.sanctioned`（带到期时间），不是含糊的「没权限」 |
| ACL 在等级门槛之前 | ACL 是布尔闸门（一次查表），等级门槛要读 `users.level`；把便宜的放前面，且 `acl_enabled=false` 时不该多读一次 users |
| 拉黑在最后 | 拉黑只与「这条回复是对谁说的」有关，必须先知道 `parent_id` 解出对象才能判；它也必须发生在事务之外（判定失败不该开事务） |

### 4.2 发主题 POST /api/v1/topics（完整事务边界）

```go
// 事务内只做数据库读写 + EnqueueTx（拍板 §5.4）
err := db.WithTx(ctx, s.db, func(tx *ent.Tx) error {
    // ① 主题行
    // ② 1 楼（floor = 1）
    // ③ 配图引用 +1（topic_images 行 + images.refcount）
    // ④ client_token 冲突 → 返回已存在的那条（见 §4.3）
    // ⑤ EnqueueTx(search:index, {id})   ← 唯一允许的副作用，与业务同事务
    // ⑥ EnqueueTx(notify:mention / notify:review) —— 由 D4 处理
    return nil
})
// 事务外：miss 的计数（view_count 不在这里）、响应组装
```

```sql
-- ① 主题行（$1=public_id, $2=board_id, $3=author_id, $4=kind, $5=title, $6=excerpt,
--    $7=review_state, $8=client_token(默认空串), $9=now, $10=resource_status）
INSERT INTO topics (public_id, board_id, author_id, kind, title, excerpt,
                    review_state, resource_status, client_token,
                    last_reply_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $10, $8, $9, $9, $9)
RETURNING id;

-- ② 1 楼（$1=public_id, $2=topic_id, $3=author_id, $4=content_md, $5=content_html, $6=now）
INSERT INTO posts (public_id, topic_id, author_id, floor, content_md, content_html, created_at, updated_at)
VALUES ($1, $2, $3, 1, $4, $5, $6, $6)
RETURNING id;

-- ③ 配图：**本域不写**。图的挂/摘走 D5 的端点（POST/DELETE /api/v1/topics/{id}/images，handler 归 media），
--    表 topic_images 与 refcount 都在 D5（D5 §4.1 / §4.3）。
--    本域只在发主题时按前端传来的 images[] 调 D5 的引用接口，或干脆让前端在发帖成功后单独调图片端点
--    （方案 §21.2 的端点形状就是后者：POST /posts/{id}/images 单列）。**倾向后者**：发帖事务里不碰图片，
--    这样"图片上传失败"不会把整个发帖回滚掉（用户丢的是图，不是帖子）。【未决：见 §12.3-9】
```

**`review_state` 怎么定**（拍板 §2.2 第 1 条）：

```go
state := "approved"
if !actor.IsSuper && !actor.Perms.Has("post.review") && !user.Trusted {
    state = "pending"            // 审核豁免：trusted 用户或持审核权限的人直接发布
}
// actor.Trusted 不存在于 authz.Actor（D2 §8.4 的字段表）→ 走 deps.go 的 UserLookup.GetAuthBrief
// ping 一次拿 trusted/level，避免为了两个字段再查一次 users
```

### 4.3 `client_token` 幂等（做，而且两处都要）

**为什么做**：发帖是「按一次按钮、可能提交两次」的典型场景（弱网 + 双击 + 前进后退重发）。
没有幂等键时用户会得到两个一模一样的主题，而作者本人的删除按钮只删得掉一个。

```sql
-- topics 上的幂等索引（DDL 里已有）
CREATE UNIQUE INDEX uq_topics_author_client_token ON topics (author_id, client_token) WHERE client_token <> '';
CREATE UNIQUE INDEX uq_posts_author_client_token  ON posts  (author_id, client_token) WHERE client_token <> '';
-- 谓词只引用列 → IMMUTABLE（拍板 §5.9 第 1 条）。空串不参与唯一性，所以"不带 token"的请求永不冲突。
```

**冲突处理（唯一正确的一步：插入失败后回查，而不是先查再插）**：

```go
id, err := s.repo.InsertTopic(ctx, tx, in)
if ent.IsConstraintError(err) && in.ClientToken != "" {
    // 只有一种约束能撞：同一作者的同一个 token。回查那一条，200 返回它（不是 409）。
    // 先查再插会在并发下两个请求都查到"不存在"然后都插——那正是幂等键要解决的事。
    return s.repo.TopicByClientToken(ctx, tx, authorID, in.ClientToken)
}
```

**语义边界（写下来免得被当 bug 报）**：同一个 token 但 body 不同 → **仍然返回第一次的结果**（token 代表「这一次提交」）；
token 只在 `visibility='normal'`、非空时唯一，所以软删的主题不会永久占用一个 token。
**不做 `Idempotency-Key` 响应头、不做 24 小时过期**：token 由前端在打开编辑框时生成，生命周期就是那个编辑框。

### 4.4 发回复 POST /api/v1/topics/{id}/posts

```sql
-- ① 顶行锁：让同一主题的并发回复串行分配 floor（这是全域唯一需要 FOR UPDATE 的地方）
SELECT id, kind, locked_at, visibility, review_state, author_id
  FROM topics WHERE id = $1 FOR UPDATE;
-- 锁的是主题行不是 posts：posts 上没有"帖内计数"要保护，floor 的唯一性由 uq_posts_topic_floor 兜底。
-- 事务只有"锁主题行 + 插一行 + 改一行"三步，持锁时间在毫秒级（拍板 §5.4 / 方案 §14.6 第 2 条）。

-- ② 分配 floor（$1=topic_id, $2=parent_id）
INSERT INTO posts (public_id, topic_id, author_id, parent_id, floor,
                   content_md, content_html, client_token, created_at, updated_at)
SELECT $3, $1, $4, $2,
       COALESCE((SELECT max(floor) FROM posts WHERE topic_id = $1), 0) + 1,
       $5, $6, $7, $8, $8
RETURNING id, floor;
-- 并发两条回复：第一条持锁并提交；第二条在 FOR UPDATE 上等到提交后重新读到新的 max(floor)。
-- 即使这里判错，uq_posts_topic_floor 也会让第二条报唯一冲突 → service 重试一次（丢给客户端 409 是错的：用户没做错任何事）。

-- ③ 推 last_reply_at 与重算 reply_count（同一条语句，见 §3.7 Q8a 的取舍）
UPDATE topics t
   SET reply_count  = (SELECT count(*) FROM posts p
                        WHERE p.topic_id = t.id AND p.floor > 1 AND p.visibility = 'normal'),
       last_reply_at = $2,          -- 新回复的 created_at
       updated_at    = t.updated_at -- 回复不动 updated_at，见 §2.2
 WHERE t.id = $1;
```

**`parent_id` 的校验位置（楼中楼只允许一级）—— 在 service，且只有一处**：

```go
if in.ParentID != nil {
    parent, err := s.repo.PostByPublicID(ctx, tx, *in.ParentID)   // 一次主键查找
    if err != nil { return ErrPostNotFound }
    if parent.TopicID != topic.ID     { return ErrInvalidP(reply_parent_cross_topic) }  // 400
    if parent.ParentID != nil         { return ErrInvalidP(reply_parent_nested) }        // 400：父必须是顶层回复
    if parent.Visibility != "normal"  { return ErrPostNotFound }                          // 404：不回一条已删的楼
}
```

**DB 上做不到这个约束**（CHECK 不能跨行、不能看父行的 parent_id），所以：

- 它是**信任边界校验**（HTTP 入参），必须做，且必须在事务里做（要在同一快照下读父行）；
- 自检 §11.2 第 4 条按 SQL 扫全表证明没有二级楼中楼（外部工具、历史数据、以后的手工 SQL 都可能造出来）；
- **不做触发器**：一条 DDL 就能绕过它，而扫描自检能在事后发现。

### 4.5 编辑 PATCH /api/v1/topics/{id} 与 PATCH /api/v1/posts/{id}

| 改什么 | 谁可以 | 额外动作 |
|---|---|---|
| 主题标题 | 作者（`topic.edit.own`）/ `topic.edit.any` | 重算 `excerpt` 不需要；`EnqueueTx(search:index)`；`updated_at = now` |
| 主题正文（1 楼） | 同上 | 重算 `excerpt`；`EnqueueTx(search:index)`；`updated_at`（主题与楼层各一次） |
| `board_id`（移动分区） | **只有** `topic.move` | 见下方 SQL |
| `kind`（讨论 ⇄ 资源 ⇄ 转载） | 作者或 `topic.edit.any` | **`resource → 非 resource` 时删掉它的 topic_sources**（否则留下挂错地方的下载源）；反向不做补数据 |
| `resource_status` | 作者或 `topic.edit.any`，`kind=resource` 时才允许非空 | CHECK 兜住 |
| 回复正文 | 作者 / `topic.delete.any` | `updated_at`；**不动 `last_reply_at`**（编辑不是回复） |

```sql
-- 移动分区：改 board_id，并按需要重置置顶（跨分区置顶是错的）
UPDATE topics
   SET board_id = $2,
       pinned_at = NULL,          -- 置顶是"在某个分区置顶"，换了分区就不成立
       updated_at = $3
 WHERE id = $1 AND visibility <> 'deleted'
RETURNING board_id;
-- 权限点 topic.move；写审计（action=topic.move，detail 带 before/after board_id）由 D6 的审计接口落。
```

```sql
-- 编辑 1 楼正文时同步主题的 excerpt 与 updated_at（两行都在同一事务）
UPDATE posts   SET content_md = $2, content_html = $3, updated_at = $4 WHERE id = $1;
UPDATE topics  SET excerpt = $3, updated_at = $4 WHERE id = $2;   -- $3 = 新的 excerpt
```

**编辑的可见性副作用**：被编辑的 1 楼正文变了 → 必须重投 `search:index`（D5 §6.5 的触发点表里已经列了这一条）。
**没有 `post_revisions`**（拍板 §6）：编辑直接覆盖，历史版本不进库。

### 4.6 删除：三种软删，各自的确切语义

| 动作 | 端点 | 落点 | 计数 |
|---|---|---|---|
| 删主题 | `DELETE /topics/{id}` | `topics.visibility='deleted'` **+ 同一事务把所有 posts 也置 deleted** | 把该主题的 likes 全部删掉（下面的 SQL） |
| 删 1 楼 | `DELETE /posts/{id}`（floor=1） | **只软删楼层本身**，主题行不动 | `reply_count` 不变（floor 1 不算回复） |
| 删回复 | 同上（floor>1） | `posts.visibility='deleted'` | 重算 `reply_count`、重算 `last_reply_at`、删该帖的 likes |

```sql
-- 删主题（一个事务）
UPDATE topics SET visibility = 'deleted', pinned_at = NULL, featured_at = NULL, updated_at = $2
 WHERE id = $1 AND visibility <> 'deleted';
UPDATE posts  SET visibility = 'deleted', updated_at = $2 WHERE topic_id = $1;
-- 楼层的可见性跟随主题，但**不是靠读的时候 JOIN 出来的**：主题被删以后楼层必须真的不可见，
--   靠 JOIN 的话，任何一条忘了 JOIN topics 的楼层查询都会漏出去（这是"第二份真源"的反面用法：这里是刻意的冗余，
--   换取每条楼层查询都不必再信任调用者）。两处状态在同一条事务里改，漂移窗口为零。

-- 清多态点赞（多态无外键的代价，必须由应用保证；数据库文档 §12 第 7 条是兜底检查）
DELETE FROM likes
 WHERE (target_type = 'topic' AND target_id = $1)
    OR (target_type = 'post'  AND target_id IN (SELECT id FROM posts WHERE topic_id = $1));
-- 顺序：先删 posts 的 likes 再删 topic 的，或者一条语句都删（上面就是一条）。
-- topic.like_count 随行一起变成不可见，不用清零（行还活着，但没人能通过 API 看到它）。
```

（删主题时图片的引用计数由 D5 处理：本域在删主题的同一事务里调 `ImageRef.DropTopicImagesTx(ctx, tx, topicID)`，
它做的是 `DELETE FROM topic_images` + 对每个 hash `refcount - 1`。**表归 D5，计数归 D5，本域只提供事务**——见 §9.4 与 D5 §4.3 的「引用行在谁的表里，谁负责 ±1」。）

```sql
-- 删回复（floor > 1）：软删 + 重算两个派生列
UPDATE posts SET visibility = 'deleted', updated_at = $2 WHERE id = $1;

UPDATE topics t
   SET reply_count  = (SELECT count(*) FROM posts p
                        WHERE p.topic_id = t.id AND p.floor > 1 AND p.visibility = 'normal'),
       last_reply_at = COALESCE((SELECT max(p.created_at) FROM posts p
                                  WHERE p.topic_id = t.id AND p.visibility = 'normal'),
                                t.created_at),
       updated_at    = t.updated_at
 WHERE t.id = $3;
-- last_reply_at 的 COALESCE 兜底是给"只剩 1 楼"准备的：1 楼必然存在（不会物理删除），
--   所以 COALESCE 命中的其实是 t.created_at —— 那正是"最后一条楼层就是 1 楼"该有的值。
-- **NOT NULL 因此不会在这一步被破坏**：这是 §0 结论 1 换来的最大好处。
-- 删的是楼中楼时同样跑这句：reply_count 与 last_reply_at 都是"帖子整体"的派生量，不区分层级。
```

**删除路径上的权限**：作者 → `topic.delete.own`；非作者 → `topic.delete.any` **或** `board.moderate` + `authz.CanInBoard(actor, boardID)`（拍板 §1.2：版主删帖是作用域权限，不进中间件）。
两条件 AND（D2 §8.4 第 3 条的收尾语）：**先 `Require` 再判归属/作用域**。

**删完不收尾会怎样**：主题被删后它的 `topic_search` 行由 `search:index` 任务删掉（D5 §6.5 第 4 步）。
**本域必须投这个任务**——否则被删的帖子还能被搜到，而"软删"承诺就失效了（盲审安全项 D2 点名的正是这条）。

### 4.7 锁定 / 置顶 / 精华

```sql
-- 锁定（POST /topics/{id}/lock，body { locked: bool }）——幂等：重复锁不报错
UPDATE topics SET locked_at = CASE WHEN $2 THEN COALESCE(locked_at, $3) ELSE NULL END, updated_at = $3
 WHERE id = $1 AND visibility <> 'deleted'
RETURNING locked_at;
-- COALESCE 保证"重复锁定"不刷新时间戳（时间戳是"什么时候锁的"，不是"最后一次有人点锁定"）。

-- 置顶（POST /topics/{id}/pin）与精华（…/feature），形状相同
UPDATE topics SET pinned_at = CASE WHEN $2 THEN COALESCE(pinned_at, $3) ELSE NULL END, updated_at = $3
 WHERE id = $1 AND visibility <> 'deleted' AND kind <> 'repost'
RETURNING pinned_at;
-- 不允许置顶"转载"类：转载帖是别人的内容，置顶它等于替别人做宣传（这是产品判断，写在这里当作规则）。
-- 权限点：topic.pin（置顶与精华共用，拍板 §1.2 的端点表就是这么落的）。
```

### 4.8 汇报（reports）不在本域

`reports` 表属 D6（运营域）。本域只提供两件东西：**被举报对象的归属解析**（`target_type` + `target_id` → 作者 id，用于判定"能不能处理"）与**软删时清掉该对象的未处理举报**（`DELETE /admin/reports` 不是本域端点）。
两者的 SQL 都很短，放在 D6 更合理——本域只暴露 `ResolveTargetOwner(ctx, targetType string, targetID int64) (ownerID int64, err error)`。

---

## 5. 点赞 / 点踩（likes）与收藏（bookmarks）

### 5.1 投票：`PUT /posts/{id}/vote` 的幂等实现（一条语句）

```sql
-- $1=user_id, $2=target_type, $3=target_id, $4=value(±1), $5=now
WITH up AS (
  INSERT INTO likes (user_id, target_type, target_id, value, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $5)
  ON CONFLICT (user_id, target_type, target_id) DO UPDATE
     SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
   WHERE likes.value IS DISTINCT FROM EXCLUDED.value
  RETURNING (xmax = 0) AS inserted, value
), delta AS (
  SELECT COALESCE(sum(CASE WHEN value =  1 THEN 1 ELSE 0 END), 0)::int AS d_like,
         COALESCE(sum(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)::int AS d_dislike,
         count(*) > 0                                                    AS touched
    FROM (
      SELECT value FROM up
      UNION ALL
      SELECT -$4 WHERE EXISTS (SELECT 1 FROM likes
                              WHERE user_id = $1 AND target_type = $2 AND target_id = $3)
        AND NOT EXISTS (SELECT 1 FROM up)
    ) s
)
UPDATE posts p
   SET like_count    = p.like_count    + d.d_like,
       dislike_count = p.dislike_count + d.d_dislike
  FROM delta d
 WHERE p.id = $3 AND $2 = 'post' AND d.touched;
-- 三条性质一起成立：
--   ① 重复 PUT 同值 → up 的 DO UPDATE 被 WHERE 拦住 → up 空 → delta 空 → UPDATE 不跑（计数不动）；
--   ② 从 -1 改成 +1 → up 返回 value=1 → d_like=+1, d_dislike=-1（两侧同时平移）；
--   ③ 与并发请求竞争：ON CONFLICT 会等对方的行锁，等完再判 WHERE。
--      对方已经改成同值时本事务的 WHERE 为假 → 不更新 → 计数不动。**这就是 CAS 语义，不需要显式锁。**
-- 目标不是 post 时（topic / issue_comment）改用对应的表与列，分派表见 §5.2。
```

**主题只有赞没有踩**：`target_type='topic'` 时 service 层只接受 `value=1`（`value=-1` → 400 `common.invalid_input`）。
DDL 上做不到按 target_type 分档的 CHECK（要带子查询），所以这条规则的落点是 service + 自检 §11.2 第 5 条。

### 5.2 目标类型分派表

| target_type | 计数列写哪 | 端点 |
|---|---|---|
| `post` | `posts.like_count` / `posts.dislike_count` | `PUT /api/v1/posts/{id}/vote`、`DELETE` 同路径 |
| `issue_comment` | `issue_comments.like_count` / `dislike_count` | `PUT /api/v1/issue-comments/{id}/vote`、`DELETE` 同路径 |
| `topic` | `topics.like_count`（只有 `value=1`，所以只有一个方向） | `PUT /api/v1/topics/{id}/like`、`DELETE` 同路径 |
| `issue` | **无计数列，也没有端点** | 不做。CHECK 里留着它是为了以后加字段时不改约束，现在没有任何路径写它 |

### 5.3 取消投票 `DELETE`（幂等，一条语句）

```sql
-- $1=user_id, $2=target_type, $3=target_id
WITH del AS (
  DELETE FROM likes
   WHERE user_id = $1 AND target_type = $2 AND target_id = $3
  RETURNING value
)
UPDATE posts p
   SET like_count    = p.like_count    - CASE WHEN d.value =  1 THEN 1 ELSE 0 END,
       dislike_count = p.dislike_count - CASE WHEN d.value = -1 THEN 1 ELSE 0 END
  FROM del d
 WHERE p.id = $3 AND $2 = 'post';
-- 没有票时不删任何行 → UPDATE 零行 → 幂等成功（200 + 当前计数，不是 404）。
-- 计数不可能减到负数：like_count 只在删到 value=1 的行时才减，而那一行正是当初加过的。
-- **仍然**加 CHECK (like_count >= 0)：一次手工 SQL 或一次漏写的补偿就会让它变负，而负数计数在界面上就是"这个站坏了"。
--   CHECK 让那次错误的写请求当场 500（而不是安静地留下 -3），代价是运维要去看日志。值。
```

### 5.4 收藏：`PUT` / `DELETE /topics/{id}/bookmark`

```sql
-- PUT（幂等）
INSERT INTO bookmarks (user_id, topic_id, created_at) VALUES ($1, $2, $3)
ON CONFLICT (user_id, topic_id) DO NOTHING;
-- DO NOTHING 而不是 DO UPDATE：收藏时间就该是第一次收藏的时间（改时间会让收藏夹顺序跳变）。

-- DELETE（幂等）
DELETE FROM bookmarks WHERE user_id = $1 AND topic_id = $2;
-- 未收藏时删 → 0 行 → 200，不是 404。

-- 详情里的 viewer 三态（Q6 已含；这里单列出来说明它只要两次索引查找）
SELECT (SELECT value FROM likes WHERE user_id=$1 AND target_type='topic' AND target_id=$2) AS my_vote,
       EXISTS (SELECT 1 FROM bookmarks WHERE user_id=$1 AND topic_id=$2)                   AS bookmarked;
-- $1=0（游客）时各返回 NULL / false。
```

### 5.5 「列表里不许 N+1」的落地位置（本域唯一一处）

**规则**：任何返回「多条可投票对象」的查询，都必须把 `my_vote` 放进**那条查询本身**（`LEFT JOIN likes`）。

| 列表 | my_vote 取法 | 状态 |
|---|---|---|
| 回复列表 Q3a / 楼中楼 Q3b | 同一 SQL 的 `LEFT JOIN likes` | ✔ |
| Issue 评论列表 §7.8 | 同一 SQL 的 `LEFT JOIN likes` | ✔ |
| 主题详情 Q6 | 两个标量子查询（一行数据，不构成 N+1） | ✔ |
| 主题列表 Q1 / Q2 / Q4 / Q5 | **不带 my_vote** | 不适用 |

**为什么不给主题列表加 `my_vote`**：卡片上没有"点赞"交互（点进去才能赞），加它只买到 20 行 join 的代价；
主题列表要的是 `like_count`（数字），那个就在 `topics` 行上。
**`viewer.bookmarked` 同理只在详情给**：收藏夹页本身按定义全是已收藏的。

---

## 6. BoardACL 与禁言的判定

### 6.1 ACL 表怎么读（拍板 §1.5 的 6 步 → 一次查询拿全，不要 4 次）

```sql
-- $1 = board_id, $2 = actor.RoleID, $3 = actor.UserID, $4 = now
SELECT b.id AS board_id, b.acl_enabled, b.min_post_level, b.status AS board_status,
       COALESCE(acl.can_post,   false) AS can_post,
       COALESCE(acl.can_reply,  false) AS can_reply,
       COALESCE(acl.deny_post,  false) AS deny_post,
       COALESCE(acl.deny_reply, false) AS deny_reply,
       (acl.role_id IS NOT NULL)       AS has_role_row,
       s.until                         AS sanction_until,
       EXISTS (SELECT 1 FROM board_moderators m
                WHERE m.board_id = b.id AND m.user_id = $3) AS is_moderator
  FROM boards b
  LEFT JOIN board_acls acl ON acl.board_id = b.id AND acl.role_id = $2
  LEFT JOIN LATERAL (
    SELECT min(sa.until) AS until
      FROM sanctions sa
     WHERE sa.user_id = $3
       AND (sa.board_id IS NULL OR sa.board_id = b.id)
       AND (sa.until IS NULL OR sa.until > $4)
  ) s ON true
 WHERE b.id = $1 AND b.status = 'active';
```

**一条查询、四张表、四个索引**：`boards` 主键、`board_acls` 主键 `(board_id, role_id)`、
`board_moderators` 主键 `(board_id, user_id)`、`sanctions` 的 `idx_sanctions_user`。
**没有第五支**——「我这个角色有没有 `topic.create`」已经在 `actor.Perms` 上（D2 的装配查询一次取回），再查 `role_permissions` 就是第二份真源。

### 6.2 最终判定（Go，与拍板 §1.5 逐条对齐）

```go
func (r *aclRow) Can(action string) bool  { if action == "post" { return r.CanPost };  return r.CanReply }
func (r *aclRow) Deny(action string) bool { if action == "post" { return r.DenyPost }; return r.DenyReply }
```

| 拍板 §1.5 的步 | 本域落地 | 返回 |
|---|---|---|
| 1 `actor.IsSuper` | §4.1.1 第 1 行短路，**这条 SQL 都不查** | — |
| 2 未过期 Sanction（`board_id IS NULL` 或该分区） | `sanction_until != nil`（或永久，见 §6.3） | 403 `forum.sanctioned` + `until` |
| 3 `acl_enabled = false` → 放行 | `!ACLEnabled` → 跳过 4/5/6，只过等级门槛 | — |
| 4 该用户**基线角色那一行** deny → 拒绝 | `Deny(action)` | 403 `board.acl_denied` |
| 5 同一行 can → 放行 | `Can(action)` | — |
| 6 该分区**没有任何该角色的行** → 拒绝 | `!HasRow` | 403 `board.acl_denied` |

**「禁止优先」在表结构上就成立了**：`ck_board_acls_no_contradiction` 不允许同一行既 deny 又 can，
所以第 4 步与第 5 步永远只有一个会命中，不需要额外的优先级规则。

**不做「给某个人单独 deny 一个分区」**：`board_acls` 是「角色 × 分区」的矩阵，没有 per-user 行。
真要单独禁某个人，用 `sanctions`（分区级限期禁言）——那才是它的用途，而且它还有到期时间。

### 6.3 禁言（sanctions）

```sql
-- 发言前判定（§4.1.1 第 2 步；一次索引查找）
SELECT sa.until
  FROM sanctions sa
 WHERE sa.user_id = $1
   AND (sa.board_id IS NULL OR sa.board_id = $2)
   AND sa.action IN ($3, 'all')
   AND (sa.until IS NULL OR sa.until > $4);
-- $1=user_id, $2=board_id, $3='post'|'reply', $4=now
-- 索引 idx_sanctions_user (user_id, until)：user_id 等值 + until 过滤。
-- **时间比较在 WHERE 里，不在索引谓词里**（拍板 §5.9 第 1 条：now() 不是 IMMUTABLE，那样的索引建不出来）。
-- 返回 0 行 → 没有禁言。返回 ≥1 行 → 命中；其中有 until IS NULL 的那行表示永久（msg 里不带到期时间）。
--   命名/署名集合很小（每人 ≤ 几条），不做 min(until) 聚合——Go 侧扫这几行更清楚。
```

**判定位置**：service 的 `canSpeak`（§4.1.1），**不在中间件**——中间件里没有 `board_id`，判它得先查库（方案 §9.8 已定）。
覆盖五条写路径：发主题、发回复、发 issue、发 issue 评论、传配图。
**不覆盖**：编辑、删除、收藏、投票、拉黑——那些不是"发言"，被禁言的人当然要能删掉自己违规的那条。

```sql
-- 管理端写入（POST /api/v1/admin/users/{id}/sanctions，权限点 user.mute）
INSERT INTO sanctions (user_id, board_id, action, reason, until, created_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id;
-- board_id = NULL 表示全站；until = NULL 表示永久。写审计由 D6 落。
-- **不禁用会话**：禁言只挡发言，不踢登录（踢登录是 user.ban 的事）。
```

### 6.4 发帖门槛（`boards.min_post_level`）

```sql
SELECT u.level FROM users u WHERE u.id = $1;
-- level < boards.min_post_level → 403 forum.level_too_low，msg 带「需要 N 级」。
-- 等级公式的唯一实现在 D4（level = floor(sqrt(exp/100)) + 1），本域只读不写。
-- **放在 canSpeak 的最后**：它是唯一要读 users 表的一步，前面几步都可能提前拒绝。
-- 【未决 12.3-6】新用户 level 恒 ≥ 1（默认 exp=0 → level=1），所以 min_post_level=1 等于"不限"。
```

---

## 7. 下载源（topic_sources）与 Issue

### 7.1 这一块 2026-10-12 被改过需求，先写清改动

| 项 | 旧需求（`界面施工` §2.2 初版） | **现行需求**（用户 2026-10-12 改，以 W2 已出的图为准） |
|---|---|---|
| 展示形态 | 一个来源一行横条，每行左边「网盘/GitHub」方块 + 右边「转链下载」按钮 | **mcmod.cn 那样一排网站 logo 按钮**，点 logo 直接进网页 |
| `provider` 取值 | `netdisk \| github` 两个闭集 | **开放小集合**：前端 `resource-sources.tsx` 的表里已经有 10 个 key，取不到就回落通用图标 |
| GitHub 镜像自动寻找 | 服务端探测 GitHub 镜像并 302 到最快的那个 | **废弃**。都是点按钮直接进网页，没有服务端探测 |
| 转链端点 | `.../go` → 302 + 计数 | **保留**，但语义收窄：**它只是计数与改链的落点，不做镜像探测** |

**图标不存库**：`topic_sources` 里**没有 icon / logo / color 列**。
图标由前端按 `provider` 这个字符串去查它自己的 `SOURCE_SITE` 表（`web/src/devroom/pages/12-topic/resource-sources.tsx` 第 12–23 行，就是「开放映射 + 回落 other」的写法）。
后端只保证 `provider` 是**稳定的英文小写 key**——加一个网盘站只需要前端加一行映射，数据库一行都不用改。
**后端不做图标接口**（`GET /api/v1/providers` 之类的）：前端已经有表，多一个端点就多一处要同步。

**与前端 key 集合的对账**（这是 CHECK 的取值来源，不是我编的）：

| 前端 key | 本域 CHECK 里有没有 | 说明 |
|---|---|---|
| `baidu` `aliyun` `quark` `lanzou` `onedrive` `mega` `github` `other` | ✔ | 前端表里有专属图标 |
| `pan123` `weiyun` `gitee` | ✔ | 前端表里**没有**——它落到 `other` 的图标 + 自己的 label。旧站 `0005_sections_sources.sql` 的 provider 注释里有 123pan / weiyun，保留以免丢失存量语义 |
| `netdisk` | ✘ **刻意不在 CHECK 里** | 它是前端旧模型的占位 key（没有信息量），新数据不该产生它；旧 mock 里的值由迁移一次性映射掉 |
| `website` | ✔ | W2 的表里有（「官方网站」）——旧站的 `direct` 直链是它的前身 |

**CHECK vs 开放集合的边界**：`provider` 上**有** CHECK。理由：它是**语义字段**而不是自由文本，写了 'Baidu'、'baidu-netdisk'、'百度' 的数据会让前端回落成通用图标（用户看到一排问号）；
CHECK 让这类写入在**开发期**就报错，代价是加一个新站点要一条迁移——而前端本来就要加一行图标映射，两处一起改反而是好事。
**如果你希望它完全不设 CHECK**：删掉 `ck_topic_sources_provider` 一行即可，其余设计不受影响（这是 §12.3-7 的未决项）。

### 7.2 转链端点 `GET /api/v1/topics/{topicId}/sources/{sourceId}/go`

```
1. 解析 topicId/sourceId（都是 public_id；解不开 → 400 common.invalid_input）
2. 一次查询拿 source + 所属 topic 的可见性（下面的 SQL）
3. 无行 / 主题不可见 → 404 common.not_found（**这里必须真的看不到，否则它可以用来探测隐藏主题**）
4. 限流：ratelimit.Allow("forum:go:<ip>", 30, 1*time.Minute)；超限 → 429 forum.rate_limited（带 Retry-After）
5. counter.Add("source:go:<source_id>")   ← 计数只进缓冲，不写库（§8.2）
6. 302 Location: <topic_sources.url>，带 Cache-Control: no-store
```

```sql
SELECT s.id, s.url
  FROM topic_sources s
  JOIN topics t ON t.id = s.topic_id
 WHERE s.public_id = $1 AND t.public_id = $2
   AND t.visibility = 'normal' AND t.review_state = 'approved';
-- 走 topic_sources.public_id 的唯一约束 + topics 主键，两次索引查找。
-- **不做**「source 与 topic 是否匹配」的二次校验：JOIN 条件本身就是它。
```

**为什么它必须存在（而不是前端直链）**：网盘直链会失效，失效后需要一个统一的地方改；而且直链被爬走等于绕过了限流。
**为什么它不做镜像探测**：现行需求里 GitHub 镜像自动寻找已废弃。这条路径上**只有计数与 302**，没有 HTTP 出站请求——
一个读接口里发 HTTP 是禁止事项（方案 §15），而且它会让"点一下按钮"变成一次不可控的等待。

**`url` 不做域名白名单**：作者填什么就跳什么。理由：这是一排"点进网页"的按钮，网盘域名有几百个，白名单只会变成维护负担；
而**开放重定向的风险由三处收掉**：①限流（30/分钟/IP）②`Cache-Control: no-store`③它只跳作者在资源帖里显式登记过的 URL（不是任意 `?url=` 参数）。
**如果以后要收紧**：加一条 `url` 的域名白名单 CHECK 即可，落点是迁移，不是应用代码。

### 7.3 写下载源（`POST/PATCH/DELETE /api/v1/topics/{id}/sources[/{sid}]`）

| 动作 | 权限 | 规则 |
|---|---|---|
| 新增 | `topic.edit.own`（作者）或 `topic.edit.any` | 主题 `kind` 必须是 `resource`（否则 400 `forum.not_resource`）；每帖 ≤ 20 条 |
| 修改 | 同上 | **改 `url` 时 `verified_at` 不动**——「我确认它还有效」是一个显式动作（下一步），不该被改错别字顺带刷掉 |
| 确认有效 | 同上 | `POST .../sources/{sid}/verify` → `verified_at = now, upkeep = 'active'`（两个字段一起变：点"我确认还有效"就是在说"它还能下、我还在维护"） |
| 归档 | 同上 | `upkeep = 'archived'`，**不删行**（删了就丢掉了"这里曾经有过一个源"的信息，而 issue 里可能正讨论它） |
| 删除 | 同上 | 真删（`DELETE`）。与归档的区别：填错了、重复了才删 |

```sql
-- sort 的分配：与 posts.floor 同一套办法（同一主题内 max+1），但**不需要 FOR UPDATE**：
--   sort 只影响显示顺序，重复了不会让任何东西坏掉（idx_topic_sources_topic 的 (topic_id, sort, id) 里 id 兜底）。
INSERT INTO topic_sources (topic_id, provider, label, url, extraction_code, size_text, upkeep, sort, created_at)
SELECT $1, $2, $3, $4, $5, $6, 'active',
       COALESCE((SELECT max(sort) FROM topic_sources WHERE topic_id = $1), 0) + 1, $7
RETURNING id;
-- 并发两条新增 → 同一个 sort 值 → 显示顺序由 id 兜底（顺序稳定，只是不是"谁先点谁在前"）。
-- 为此上锁不值得：sort 可以事后重排，floor 不能。
```

### 7.4 `resource_status` 与 `upkeep` 是两件事（写下来免得被合并）

| 字段 | 回答的问题 | 取值 | 谁的字段 |
|---|---|---|---|
| `topics.resource_status` | **这个资源整体还有人维护吗** | `maintained` / `bugfix_only` / `unmaintained` | 主题（一个值） |
| `topic_sources.upkeep` | **这一条链接还是活的吗** | `active` / `archived` | 单个来源（每个源一个值） |

常见组合：整个项目 `maintained`，但某个旧网盘链接 `archived`（换了新网盘）——**合并成一个字段就表达不了它**。
前端的「作者最后更新于 …；资源本体由第三方托管」那句说明（`UpkeepNote`）读的是 `topics.updated_at`，与这两个字段都无关。

### 7.5 Issue：表与状态开关

```sql
-- 四类 kind 的 CHECK 已在 §2.1；状态开关的两条写路径：

-- 关闭（作者走 topic.edit.own，非作者走 topic.lock；见 §7.9）
UPDATE post_issues i
   SET status = 'closed', closed_by = $2, closed_at = $3, updated_at = $3
 WHERE i.public_id = $1 AND i.status = 'keep_open'
RETURNING i.id;
-- 已关闭再关 → 0 行 → 幂等成功（200）。**不返回 409**：用户重复点"关闭"不是错误。
-- 重新打开：status = 'keep_open', closed_by = NULL, closed_at = NULL（与 CHECK 一致）。
-- 这两个动作共享一条 UPDATE 的骨架，用参数决定目标状态，不要写成两条几乎一样的 SQL。
```

| 动作 | 权限 | 判定 |
|---|---|---|
| 关闭 / 重开 | 作者 → `topic.edit.own`；非作者 → `topic.lock`（或 `board.moderate` + `CanInBoard`） | 拍板 §「界面施工」§3.5 的建议被采纳：**关 Issue 与锁主题是同一类动作** |
| 改标题 / 正文 | 作者 → `topic.edit.own`；管理员 → `topic.edit.any` | 编辑后 `updated_at` 前进（列表按它倒序） |
| 指派 | 作者或 `topic.lock` | `assignee_id` 只能指向**有发言权的人**（不过多校验：填一个不存在的 handle → 404 `user.not_found`） |

### 7.6 发 Issue（编号取号在这条事务里）

```sql
-- ① 锁资源帖行（同 §4.4：让同一主题的并发提号串行）
SELECT id, kind, locked_at, visibility FROM topics WHERE id = $1 FOR UPDATE;
-- 非 resource → 400 forum.not_resource；locked → 403 topic.locked；不可见 → 404。

-- ② 取号 + 插入（一条语句：max(number)+1 在 FOR UPDATE 保护下是安全的）
INSERT INTO post_issues (public_id, topic_id, author_id, number, kind, title,
                         body_md, body_html, body_text, client_token, created_at, updated_at)
SELECT $2, $1, $3,
       COALESCE((SELECT max(number) FROM post_issues WHERE topic_id = $1), 0) + 1,
       $4, $5, $6, $7, $8, $9, $10, $10
RETURNING id, number;
-- uq_post_issues_topic_number 是第二道闸：即使锁判错，重复编号也会被唯一索引拦住。
-- 编号从 1 开始，#1 是"这个资源的第一个 bug"——这符合 GitHub 的直觉。
```

**为什么编号用 `(topic_id, number)` 而不是全站自增**：全站自增会让每个资源的编号从 #4831 开始（暴露全站 issue 总量，也让"这个资源收到 12 条反馈"这件事看不出来）。
**暴露面**：`number` 是可枚举的连续整数，所以它能被用来推断"这个资源有多少条 issue"。
**但这个数本来就公开**（`issue_open_count` + 列表长度），所以不构成新的泄漏。

### 7.7 全站 Issue 聚合 `GET /api/v1/issues`（**进 v1**，W3 的反馈页是全站视图）

```sql
-- Q10：全站 Issue 列表。$1=status(open|closed)，$2=kind，$3=author_id，$4=assignee_id，$5=q(tsquery 串)，
--      $6=排序键(k)，$7=游标 id，$8=limit
SELECT i.id, i.public_id, i.number, i.kind, i.title, i.status,
       i.created_at, i.updated_at, i.closed_at,
       t.public_id AS topic_public_id, t.title AS topic_title,
       b.slug AS board_slug, b.name AS board_name,
       a.public_id AS author_public_id, a.username AS author_handle,
       a.nickname AS author_nickname, a.avatar_hash, a.avatar_small_hash,
       (SELECT count(*) FROM issue_comments c
         WHERE c.issue_id = i.id AND c.visibility = 'normal') AS comment_count
  FROM post_issues i
  JOIN topics t ON t.id = i.topic_id
  JOIN boards b ON b.id = t.board_id
  JOIN users  a ON a.id = i.author_id
 WHERE t.visibility = 'normal' AND t.review_state = 'approved'   -- 主题不可见 → 它的 issue 也不可见
   AND ($1::text  IS NULL OR i.status = $1)
   AND ($2::text  IS NULL OR i.kind = $2)
   AND ($3::bigint IS NULL OR i.author_id = $3)
   AND ($4::bigint IS NULL OR i.assignee_id = $4)
   AND ($5::tsquery IS NULL OR i.tsv @@ $5)
   AND (COALESCE(i.updated_at, i.created_at), i.id) < ($6::timestamptz, $7::bigint)
 ORDER BY i.updated_at DESC, i.id DESC
 LIMIT $8;
-- 索引 idx_post_issues_global (status, updated_at DESC, id DESC)：status 等值 + 游标逐字同序。
-- sort=comments 时排序键换成 comment_count（表达式）→ **不走索引**，只在首页（无游标）允许；
--   带上游标时 service 直接 400 common.invalid_input（"该排序不支持翻页"），不让它变成一条会扫全表的翻页路径。
-- sort=created 时排序键 (created_at, id)，索引仍需 status 前缀 → 用它，代价是该 status 下的排序（可接受）。
```

**参数映射（`现状` 与 `牌面` 的换算只在这一处）**：

| API | 数据库 | 谁换算 |
|---|---|---|
| `?status=open` | `status = 'keep_open'` | service 一个 `switch`，**只此一处** |
| `?status=closed` | `status = 'closed'` | 同上 |
| 不传 | `NULL`（即不过滤） | — |
| `?assignee=me` | `assignee_id = actor.UserID` | 需要登录；`assignee` 传别的值 → 400 `common.invalid_input` |
| `?q=第三关` | `$5 = plainto_tsquery('simple', search.Tokenize(q))`（D5 §6.4 的两档查询，档 2 兜底） | `internal/platform/search` |

**`assignee=me` 为什么要登录**：不登录就没有「我」；而 `assignee=<别人的 id>` 会让这个参数变成"看别人被指派了什么"的探测口。
**作者的 `author=` 用 handle 而不是 id**：URL 可读，且 `lower(username)` 表达式索引逐字命中（`WHERE lower(a.username) = lower($3)`，拍板 §5.9 第 2 条）。
**`issue_open_count` 不在这个端点上**：那是 topic 详情的一部分（§3.7 Q6），这里不需要它。

### 7.8 Issue 列表与评论

```sql
-- Q11：单帖 Issue 列表（复用 Q10 的 SQL，把 topic 条件从"可见性"换成"等值"）
--   WHERE i.topic_id = $1 AND ($2::text IS NULL OR i.status = $2)
--   索引 idx_post_issues_topic_status (topic_id, status, updated_at DESC, id DESC)：两条查询各吃一个前缀。

-- Q12：Issue 评论列表（游标按 id，与帖子回复同一套；my_vote 在同一 SQL 里）
SELECT c.id, c.public_id, c.parent_id, c.body_html, c.like_count, c.dislike_count,
       c.created_at, c.updated_at,
       a.public_id AS author_public_id, a.username AS author_handle,
       a.nickname AS author_nickname, a.avatar_hash, a.avatar_small_hash,
       my.value AS my_vote
  FROM issue_comments c
  JOIN users a ON a.id = c.author_id
  LEFT JOIN likes my ON my.user_id = $2 AND my.target_type = 'issue_comment' AND my.target_id = c.id
 WHERE c.issue_id = $1 AND c.visibility = 'normal' AND c.parent_id IS NULL
   AND c.id < $3::bigint
 ORDER BY c.id DESC
 LIMIT $4;
-- 索引 idx_issue_comments_issue (issue_id, id)。
-- 楼中楼：与帖子完全同构（parent_id 一级、idx_issue_comments_parent），端点 GET /api/v1/issue-comments/{id}/replies。
-- **不做 ?sort=hot**：理由与 §3.4 完全相同（@/ui/comment 的「最热/最新」是同一页数据的前端排序；热排序没有稳定游标）。
```

| 端点 | 方法 | 登录 | 权限点 |
|---|---|---|---|
| `/api/v1/topics/{id}/issues` | GET | — | — |
| `/api/v1/topics/{id}/issues` | POST | ✔ | `topic.create` |
| `/api/v1/issues` | GET | — | — |
| `/api/v1/issues/{id}` | GET | — | — |
| `/api/v1/issues/{id}` | PATCH | ✔ | `topic.edit.own` / `topic.lock`（见 §7.5） |
| `/api/v1/issues/{id}/comments` | GET | — | — |
| `/api/v1/issues/{id}/comments` | POST | ✔ | `topic.create` |
| `/api/v1/issue-comments/{id}/vote` | PUT / DELETE | ✔ | — |
| `/api/v1/issue-comments/{id}/replies` | GET | — | — |

**Issue 的 `tsv` 生成列（0006 迁移，追加）**：

```sql
-- 0006_issue_search.sql（与 0005 分开：生成列 + `||` 拼接必须与 D5 的 topic_search 同款写法）
ALTER TABLE post_issues ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', body_text), 'B')
  ) STORED;
-- 不做 GIN 索引：见下方说明。
```

**为什么不给 `post_issues.tsv` 建 GIN**：全站 issue 数量是主题数的零头（几十到几百条一个资源帖、全站几千条），
而 `?q=` 几乎总是与 `status` 一起用（`idx_post_issues_global` 已经把候选压到几百行）。
在几百行上做一次顺序过滤是微秒级，而 GIN 的写放大要付在每次改标题上。**等全站 issue 过万再补，那是一条迁移。**
（`topic_search` 相反：主题数是万级，且 `?q=` 常常是唯一的筛选条件，所以它有 GIN。）

---

## 8. 计数列与后台任务

### 8.1 五个计数列，各自怎么维护（**这张表是唯一真源**）

| 列 | 维护方式 | 时机 | 为什么 |
|---|---|---|---|
| `topics.reply_count` | **同事务重算**（§3.7 Q8a） | 发回复、删回复、删主题 | 读后写一致性：作者发完回复刷新页面就该看到 +1 |
| `topics.like_count` | **同事务增量**（§5.1 的 CTE） | 点赞 / 取消赞 | 同上；增量是安全的，因为增量与 `likes` 行的存在性在同一条语句里判定 |
| `posts.like_count` / `posts.dislike_count` | **同事务增量**（§5.1 的 CTE） | 投票 / 改票 / 取消 | 同上 |
| `issue_comments.like_count` / `dislike_count` | 同上，目标表换成 `issue_comments` | 同上 | 同上 |
| `topics.view_count` | **counter 缓冲 + 定时写回**（§8.2） | 主题详情被读 | 浏览量是「多一次少一次没人发现」的量；为它开一个写事务，等于让每个游客的读请求都变成写请求 |
| `topic_sources.go_count` | **counter 缓冲 + 定时写回**（§8.2） | 转链端点 | 同上，而且它天然是"可以被少算"的（没人会核对点击数） |

**分界线**：计数的**正确性**有没有人依赖？有 → 同事务；没有 → 缓冲。
`reply_count` 被人拿来分页/排序（`sort=hot` 以后可能有）、`like_count` 被拿来展示"这条评论好不好"，一处少加就会被肉眼发现；
`view_count` 与 `go_count` 只在卡片角落显示一个量级数字，差几十没人发现——而且它们能被少算，是**明写在设计里的取舍**。

### 8.2 counter 缓冲的接口与写回 SQL

```go
// internal/platform/counter（D1 平台层；本域只是第一个用户）
type Buffer interface {
    Add(key string, delta int64)          // 内存累加，永不阻塞、永不失败
    Flush(ctx context.Context, fn func(ctx context.Context, key string, delta int64) error) error
    Get(key string) int64                 // 读当前缓冲（展示时用 db 值 + 它，见下）
}
```

```sql
-- 写回（每 15 秒一次，批量）：key 形如 "view:topic:<bigint>" / "go:source:<bigint>"
UPDATE topics SET view_count = view_count + $2 WHERE id = $1;
UPDATE topic_sources SET go_count = go_count + $2 WHERE id = $1;
-- key → (表, 列, id) 的映射写在 counter 的注册处（一处），不在调用点。
-- 同一个 key 在两次写回之间的多次 Add 已经在内存里合并；写回前先取快照再清空，写回失败的值回灌（不丢计数）。
```

**读数怎么给**：`view_count = topics.view_count + counter.Get("view:topic:<id>")`。
详情页每次读都做这一次加法——**这是刻意的**：不加的话，用户刚看完的帖子浏览数不变，会被当成"浏览量坏了"。
代价是同一个主题在 15 秒窗口内的多次读会有轻微不一致（各自加到自己的快照上），这是可接受的。

### 8.3 本域投递的任务

| 任务 | 时机 | payload | 归属 |
|---|---|---|---|
| `search:index` | 发主题、改标题、改 1 楼正文、改可见性/审核态、删主题/删 1 楼 | `{"id": <topic id>}` | D5 处理（本域只投） |
| `notify:reply` | 发回复（含楼中楼） | `{"post_id": <id>}` | D4 |
| `notify:mention` | 正文里解析出 @提及 | `{"post_id": <id>}` 或 issue 对应 id | D4 |
| `notify:review` | 审核动作（approve/reject/request_revision） | `{"topic_id": <id>, "state": "..."}` | D4（`d4-social.md` §5.1 第 ⑤ 条已登记） |
| `notify:like` | 点赞（新建或由 -1 改 1 时） | `{"post_id": <id>, "user_id": <id>}` | D4 |

**全部走 `EnqueueTx`**（与业务同事务，事务回滚则任务不存在，拍板 §5.4）。
**payload 只放 id**（拍板 §5.7）：任务执行时再查一次库，拿的是"当时的"状态而不是"发帖时的"快照。
**任务的 `unique_key`**：`topic:<id>` 用于 `search:index`（D5 §6.5），其余不带（通知要被投递多次，去重会让"两个人回复你"变成一条）。

### 8.4 本域没有 cron

定时清理全在别的域：图片 GC（D5）、任务清理（D1）、邮件额度（D3-auth）。
**`sanctions` 的过期不做清理**：过期的行留着是审计痕迹（"这个人 2026 年 3 月被禁言过"），而判定本来就带 `until > now()`。
**`topics.visibility='deleted'` 的内容不做物理删除**：软删是承诺（数据库文档 §2.11）。

---

## 9. Go 接口与路由

### 9.1 文件布局（照方案 §3.1 的模块约定，不自创）

    internal/forum/
    ├── service.go     # Service、NewService、业务方法（本域唯一有业务判断的地方）
    ├── handler.go     # Handler、Register(rg, requireLogin, perm)、各 HTTP 处理函数
    ├── dto.go         # 请求/响应结构体（json + binding 标签）
    ├── repo.go        # 本域的全部原生 SQL（上面 §3/§5/§6/§7 的语句住在这里）
    ├── acl.go         # canSpeak + aclRow（§4.1.1 / §6.1）
    ├── cursor.go      # 游标编解码（§3.8）
    ├── deps.go        # 本域用到别人的小接口（§9.4）
    ├── errors.go      # 本域业务错误（§10）
    ├── tasks.go       # 本域注册的任务处理函数（只有 search:index 的投递，没有处理；所以这个文件可能不存在）
    └── service_test.go

**`repo.go` 是本域唯一的 SQL 落点**：service 不内联 SQL，handler 不碰数据库（方案 §4.2 第 5 条）。
SQL 用 `ent.Client` 的 `QueryContext` / `ExecContext` 直发（ent 表达不了 CTE / ON CONFLICT / FOR UPDATE），**不做 ent 查询构造器 + 原生 SQL 混写同一个方法**。

### 9.2 Service 方法（签名照拍板 §5.3：actor 显式入参）

```go
func NewService(db *ent.Client, clk clock.Clock, counters counter.Buffer, queue queue.Queue, deps Deps) *Service

// 读
func (s *Service) ListBoards(ctx context.Context, actor *authz.Actor) ([]BoardDTO, error)
func (s *Service) BoardBySlug(ctx context.Context, slug string) (*BoardDTO, error)
func (s *Service) ListTopics(ctx context.Context, actor *authz.Actor, in ListTopicsInput) (*TopicPage, error)
func (s *Service) ListPinned(ctx context.Context, boardID int64) ([]TopicBriefDTO, error)
func (s *Service) TopicDetail(ctx context.Context, actor *authz.Actor, publicID string) (*TopicDetailDTO, error)
func (s *Service) ListPosts(ctx context.Context, actor *authz.Actor, in ListPostsInput) (*PostPage, error)
func (s *Service) ListReplies(ctx context.Context, actor *authz.Actor, postPublicID string) ([]PostDTO, error)
func (s *Service) ListUserTopics(ctx context.Context, actor *authz.Actor, handle string, in PageInput) (*TopicPage, error)
func (s *Service) ListBookmarks(ctx context.Context, actor *authz.Actor, in PageInput) (*TopicPage, error)
func (s *Service) ListSources(ctx context.Context, topicPublicID string) ([]SourceDTO, error)
func (s *Service) GoSource(ctx context.Context, actor *authz.Actor, topicPublicID, sourcePublicID string) (string, error) // 返回 302 的目标

// 写
func (s *Service) CreateTopic(ctx context.Context, actor *authz.Actor, in CreateTopicInput) (*TopicDetailDTO, error)
func (s *Service) UpdateTopic(ctx context.Context, actor *authz.Actor, publicID string, in UpdateTopicInput) error
func (s *Service) DeleteTopic(ctx context.Context, actor *authz.Actor, publicID string) error
func (s *Service) LockTopic(ctx context.Context, actor *authz.Actor, publicID string, locked bool) error
func (s *Service) PinTopic(ctx context.Context, actor *authz.Actor, publicID string, pin, featured bool) error
func (s *Service) CreatePost(ctx context.Context, actor *authz.Actor, topicPublicID string, in CreatePostInput) (*PostDTO, error)
func (s *Service) UpdatePost(ctx context.Context, actor *authz.Actor, publicID string, contentMD string) error
func (s *Service) DeletePost(ctx context.Context, actor *authz.Actor, publicID string) error
func (s *Service) Vote(ctx context.Context, actor *authz.Actor, target VoteTarget, publicID string, value int) (*VoteResultDTO, error)
func (s *Service) Unvote(ctx context.Context, actor *authz.Actor, target VoteTarget, publicID string) (*VoteResultDTO, error)
func (s *Service) Bookmark(ctx context.Context, actor *authz.Actor, topicPublicID string, on bool) error
func (s *Service) BlockUser(ctx context.Context, actor *authz.Actor, handle string, on bool) error
func (s *Service) SaveSource(ctx context.Context, actor *authz.Actor, topicPublicID string, in SourceInput) (*SourceDTO, error)
func (s *Service) DeleteSource(ctx context.Context, actor *authz.Actor, sourcePublicID string) error
func (s *Service) VerifySource(ctx context.Context, actor *authz.Actor, sourcePublicID string) error

// Issue
func (s *Service) ListIssues(ctx context.Context, actor *authz.Actor, in ListIssuesInput) (*IssuePage, error)
func (s *Service) IssueDetail(ctx context.Context, actor *authz.Actor, publicID string) (*IssueDetailDTO, error)
func (s *Service) CreateIssue(ctx context.Context, actor *authz.Actor, topicPublicID string, in CreateIssueInput) (*IssueDTO, error)
func (s *Service) UpdateIssue(ctx context.Context, actor *authz.Actor, publicID string, in UpdateIssueInput) error
func (s *Service) ListIssueComments(ctx context.Context, actor *authz.Actor, issuePublicID string, in PageInput) (*IssueCommentPage, error)
func (s *Service) CreateIssueComment(ctx context.Context, actor *authz.Actor, issuePublicID string, in CreateCommentInput) (*IssueCommentDTO, error)

// 给别的域用（deps.go 的形状：由使用方定义接口，本域只是碰巧实现了它）
func (s *Service) BlockedBetween(ctx context.Context, a, b int64) (aBlockedB, bBlockedA bool, err error)  // D4 message 用
func (s *Service) ResolveTargetOwner(ctx context.Context, targetType string, targetID int64) (int64, error) // D6 reports 用
```

**`VoteTarget`** 是一个字符串常量集（`post` / `issue_comment` / `topic`），不是三个方法——三个方法会让"票数在哪个列上"这件事写三遍。

### 9.3 路由注册

```go
func (h *Handler) Register(rg *gin.RouterGroup, requireLogin gin.HandlerFunc, perm func(string) gin.HandlerFunc) {
    // 公开读
    rg.GET("/boards", h.listBoards)
    rg.GET("/boards/:slug", h.getBoard)
    rg.GET("/topics", h.listTopics)
    rg.GET("/topics/:id", h.getTopic)
    rg.GET("/topics/:id/posts", h.listPosts)
    rg.GET("/topics/:id/issues", h.listTopicIssues)
    rg.GET("/issues", h.listIssues)
    rg.GET("/issues/:id", h.getIssue)
    rg.GET("/issues/:id/comments", h.listIssueComments)
    rg.GET("/posts/:id/replies", h.listReplies)
    rg.GET("/issue-comments/:id/replies", h.listIssueCommentReplies)
    rg.GET("/topics/:topicId/sources/:sourceId/go", h.goSource)   // 302

    // 写（全部 requireLogin；全局权限点走中间件，作用域权限在 service 里判）
    rg.POST("/topics",                        requireLogin, perm("topic.create"),      h.createTopic)
    rg.PATCH("/topics/:id",                   requireLogin, perm("topic.edit.own"),    h.updateTopic)
    rg.DELETE("/topics/:id",                  requireLogin, perm("topic.delete.own"),  h.deleteTopic)
    rg.POST("/topics/:id/lock",               requireLogin, perm("topic.lock"),        h.lockTopic)
    rg.POST("/topics/:id/pin",                requireLogin, perm("topic.pin"),         h.pinTopic)
    rg.POST("/topics/:id/feature",            requireLogin, perm("topic.pin"),         h.featureTopic)
    rg.POST("/topics/:id/posts",              requireLogin, perm("topic.create"),      h.createPost)
    rg.PATCH("/posts/:id",                    requireLogin, perm("topic.edit.own"),    h.updatePost)
    rg.DELETE("/posts/:id",                   requireLogin, perm("topic.delete.own"),  h.deletePost)
    rg.PUT("/posts/:id/vote",                 requireLogin,                            h.votePost)
    rg.DELETE("/posts/:id/vote",              requireLogin,                            h.unvotePost)
    rg.PUT("/issues/:id/comments",            requireLogin, perm("topic.create"),      h.createIssueComment)
    rg.POST("/issues/:id/comments",           requireLogin, perm("topic.create"),      h.createIssueComment)
    rg.PUT("/issue-comments/:id/vote",        requireLogin,                            h.voteIssueComment)
    rg.DELETE("/issue-comments/:id/vote",     requireLogin,                            h.unvoteIssueComment)
    rg.PUT("/topics/:id/like",                requireLogin,                            h.likeTopic)
    rg.DELETE("/topics/:id/like",             requireLogin,                            h.unlikeTopic)
    rg.PUT("/topics/:id/bookmark",            requireLogin,                            h.bookmarkTopic)
    rg.DELETE("/topics/:id/bookmark",         requireLogin,                            h.unbookmarkTopic)
    rg.GET("/me/bookmarks",                   requireLogin,                            h.listBookmarks)
    rg.POST("/topics/:id/issues",             requireLogin, perm("topic.create"),      h.createIssue)
    rg.PATCH("/issues/:id",                   requireLogin, perm("topic.edit.own"),    h.updateIssue)
    rg.POST("/topics/:id/sources",            requireLogin, perm("topic.edit.own"),    h.saveSource)
    rg.PATCH("/topics/:id/sources/:sid",      requireLogin, perm("topic.edit.own"),    h.saveSource)
    rg.DELETE("/topics/:id/sources/:sid",     requireLogin, perm("topic.edit.own"),    h.deleteSource)
    rg.POST("/topics/:id/sources/:sid/verify",requireLogin, perm("topic.edit.own"),    h.verifySource)
    rg.PUT("/users/:handle/block",            requireLogin,                            h.blockUser)
    rg.DELETE("/users/:handle/block",         requireLogin,                            h.unblockUser)
}
```

**中间件只挂全局权限点**（方案 §9.8、拍板 §1.2）：`board.moderate`、`topic.delete.any`、归属判定全在 service。
上面把 `topic.edit.own` 挂在中间件上只是"这类动作允不允许"的第一道闸，**"这条是不是我的"仍然由 service 判**（D2 §8.4 第 3 条）。
**`/me/bookmarks` 是本域唯一的 `/me/*` 端点**：收藏是"我的"资源，但数据住在 `bookmarks` 表（本域）。

### 9.4 deps.go（本域用到别人的什么）

```go
// internal/forum/deps.go —— 接口在使用方定义（方案 §4.2 第 3 条的落地）
type UserLookup interface {
    GetAuthBrief(ctx context.Context, userID int64) (*UserAuthBrief, error)     // trusted / level（审核豁免 + 发帖门槛）
    GetBriefs(ctx context.Context, userIDs []int64) (map[int64]*UserBrief, error)// 批量补作者（D4 §3.2 已有同款）
    ByHandle(ctx context.Context, handle string) (*UserBrief, error)            // ?author= / /users/{handle}
}
type UserAuthBrief struct { ID int64; Trusted bool; Level int; Status string }

type ImageRef interface {              // 实现方：*media.Service（D5）
    DropTopicImagesTx(ctx context.Context, tx *ent.Tx, topicID int64) error
    // 删主题的同一事务里调它：DELETE topic_images + 每个 hash 的 refcount - 1。
    // 表与计数都在 D5（"引用行在谁的表里，谁负责 ±1"，D5 §4.3），本域只提供事务与归属关系。
}
// 注意：**没有 Covers**。列表封面留在本域的 Q1 里（一条 LATERAL，走 uq_topic_images_sort），
// 多一个批量接口就多一次往返与一处"封面怎么选"的歧义。

type MentionParser interface {     // 实现方：internal/platform/mention（D4 §5.6）
    Parse(md string) []int64
}
type Queue interface {             // 实现方：internal/platform/queue
    EnqueueTx(ctx context.Context, tx *ent.Tx, t queue.Task) error
}
type Counter interface {           // 实现方：internal/platform/counter
    Add(key string, delta int64)
    Get(key string) int64
}
type Renderer interface {          // 实现方：internal/platform/markdown
    Render(md string) (html string, plain string)   // html 已清洗；plain 供 excerpt 与 body_text
}
```

**只有四个接口**，每个都是本域真正会调的方法。没有 `UserService` 这种大接口、没有 `HasPerm` 之类的转发。
**`Renderer` 返回 `plain` 这一点很重要**：`excerpt` 与 `post_issues.body_text` 都必须与渲染同源（同一个 `PlainText`），
分成两处实现就会出现在正文里能看到、在摘要里看不到的字符（比如 `&amp;` 的解码时机）。

---

## 10. 错误码（本域新增；`common.*` 与 `auth.*` 见 D2）

| code | HTTP | msg（给用户看） | 什么时候 |
|---|---|---|---|
| `topic.not_found` | 404 | 主题不存在或已被删除 | 不可见 / 不存在 / 已软删（**三者同一个码**，不区分——区分就等于承认它存在） |
| `topic.locked` | 403 | 主题已锁定，不能再回复 | `locked_at` 非空 |
| `topic.review_pending` | 403 | 主题正在审核中，通过后才能回复 | 主题 `review_state='pending'`（自己的帖也不能自我回复） |
| `post.not_found` | 404 | 楼层不存在 | 同上 |
| `issue.not_found` | 404 | 反馈不存在 | 同上 |
| `forum.not_resource` | 400 | 只有资源帖可以挂下载源 / 提反馈 | `kind <> 'resource'` |
| `forum.sanctioned` | 403 | 你被禁止在此发言（至 …） | 命中未过期 sanction，`fields` 带 `until` |
| `forum.level_too_low` | 403 | 需要 N 级才能在此发帖 | `min_post_level` 门槛，`fields` 带 `level` |
| `forum.blocked` | 403 | 无法回复该用户的内容 | 拉黑（**不说是谁拉黑了谁**） |
| `board.acl_denied` | 403 | 你没有在此分区发言的权限 | ACL 第 4 / 6 步 |
| `board.not_found` | 404 | 分区不存在 | slug 找不到或 `status='archived'` 且非管理端 |
| `forum.reply_parent_nested` | 400 | 只允许回复一级评论 | `parent.parent_id != nil` |
| `forum.reply_parent_cross_topic` | 400 | 回复的评论不属于该主题 | `parent.topic_id != topic.id` |
| `forum.vote_value_invalid` | 400 | 投票值只能是赞或踩 | 主题上投 `-1`，或 value 不在 ±1 |
| `forum.page_sort_unpageable` | 400 | 该排序不支持翻页 | `sort=comments` 带游标（§7.7） |
| `forum.duplicate_client_token` | — | **不存在这个码** | token 冲突返回 200 + 第一次的结果（§4.3） |

**`topic.not_found` 一条覆盖五种情形是刻意的**：任何"因为它不存在 / 因为它不可见"的分支都会把码变成探测口。
**日志里要区分**（`slog` 带 `reason=hidden|deleted|pending|missing`），响应里不分。

---

## 11. 测试清单（每条写清断言什么）

> 铁律：**没有测试的"必须"等于没有"必须"**。下面每条都能在 CI 里跑红。集成测试一律真 PG + 独立 schema（拍板 §5.8），固定时钟用 `clock.Fake`。

### 11.1 SQL 计划与索引（`EXPLAIN` 断言，数据库文档 §12 第 11 条）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 外键索引检查（§12 第 1 条的 SQL） | 本域 13 张表零结果。**并且用一份故意删掉 `idx_posts_parent` 的夹具证明它会红**（空库跑通不算验收） |
| 2 | 重复索引检查（`pg_index` 自比较） | 零结果 |
| 3 | Q1（首页，10 万主题，第 1 页与第 50 页） | `Index Scan using idx_topics_recent`；**无 `Seq Scan on topics`**；无 `Sort`（第 50 页同样） |
| 4 | Q2a（分区页，`?board=`） | `Index Scan using idx_topics_board_live`，`Index Cond` 含 `board_id = $1` |
| 5 | Q2c（精华标签） | `Index Scan using idx_topics_featured`；`rows < 200` |
| 6 | Q3a（回复列表，1 万层的帖子） | `Index Scan using idx_posts_topic_id`；`Limit` 直接压在上方；无 `Seq Scan on posts` |
| 7 | Q5（收藏页，某人 500 条收藏） | `Index Scan using idx_bookmarks_user`；“收藏夹按收藏时间倒序”在 SQL 与索引里各写一次且一致 |
| 8 | Q10（全站 Issue，`status=open`） | `Index Scan using idx_post_issues_global` |
| 9 | Q6 的 `issue_open_count` | `Index Scan using idx_post_issues_topic_status`，`Index Cond` 用上 `(topic_id, status)` 两列 |
| 10 | §6.1 的 ACL 查询 | 4 个 `Index Scan`（boards / board_acls / board_moderators / sanctions），无 `Seq Scan` |
| 11 | Q4b 的递归 CTE | 无 `Seq Scan on topics`；`WorkTable Scan` 行数 ≤ 锚点行数（深度 1 的证据） |
| 12 | 分区统计 Q2e（单分区 5 万主题） | `Index Only Scan using idx_topics_board_live`；**耗时 < 50ms**。超过则告警（§3.3 的闸门） |

### 11.2 数据完整性自检（进 `forum check` 与 CI，必须能红）

```sql
-- 1. 多态孤儿行（likes 没有外键的代价；数据库文档 §12 第 7 条）
SELECT l.target_type, count(*)
  FROM likes l
 WHERE (l.target_type = 'topic'         AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.id = l.target_id))
    OR (l.target_type = 'post'          AND NOT EXISTS (SELECT 1 FROM posts  p WHERE p.id = l.target_id))
    OR (l.target_type = 'issue'         AND NOT EXISTS (SELECT 1 FROM post_issues i WHERE i.id = l.target_id))
    OR (l.target_type = 'issue_comment' AND NOT EXISTS (SELECT 1 FROM issue_comments c WHERE c.id = l.target_id))
 GROUP BY 1;   -- 有行即失败

-- 2. 主题被软删但楼层还活着（可见性冗余的漂移检查）
SELECT count(*) FROM topics t JOIN posts p ON p.topic_id = t.id
 WHERE t.visibility = 'deleted' AND p.visibility <> 'deleted';   -- 有行即失败

-- 3. 计数字段与实际行数不符（reply_count / like_count / dislike_count 三类）
SELECT t.id, t.reply_count, (SELECT count(*) FROM posts p
                              WHERE p.topic_id = t.id AND p.floor > 1 AND p.visibility = 'normal') AS actual
  FROM topics t
 WHERE t.reply_count <> (SELECT count(*) FROM posts p
                          WHERE p.topic_id = t.id AND p.floor > 1 AND p.visibility = 'normal');
-- 有行即失败。这条是"重算而非增量"的验收：任何时候它都该是零。

-- 4. 二级楼中楼（service 校验的唯一兜底）
SELECT count(*) FROM posts c JOIN posts par ON par.id = c.parent_id WHERE par.parent_id IS NOT NULL;
SELECT count(*) FROM issue_comments c JOIN issue_comments par ON par.id = c.parent_id WHERE par.parent_id IS NOT NULL;
-- 有行即失败

-- 5. 主题上的踩（likes 的 target_type='topic' 且 value=-1）
SELECT count(*) FROM likes WHERE target_type = 'topic' AND value = -1;   -- 有行即失败

-- 6. 非 resource 的主题挂了下载源
SELECT count(*) FROM topic_sources s JOIN topics t ON t.id = s.topic_id WHERE t.kind <> 'resource';

-- 7. topic_images 的引用与 images.refcount 的一致性（本域侧，与 D5 §11.4 的那条互补）
SELECT i.hash, i.refcount, (SELECT count(*) FROM topic_images ti WHERE ti.image_hash = i.hash) AS refs
  FROM images i
 WHERE i.refcount < (SELECT count(*) FROM topic_images ti WHERE ti.image_hash = i.hash);
-- 有行即失败（refcount 只可能大于等于本域的引用数：D5 的 post_images 也贡献引用）
```

### 11.3 业务与并发（`service_test.go`，真 PG）

| # | 用例 | 断言 |
|---|---|---|
| 1 | **并发两条回复**（同一主题，两个 goroutine） | 两条都成功、`floor` 是 n+1 与 n+2、`reply_count` = 2、`last_reply_at` = 较晚那条 |
| 2 | **并发发帖带同一个 client_token** | 两条返回**同一个 public_id**；`topics` 里只有一行；`posts` 里只有一行 1 楼 |
| 3 | **并发点赞同一帖**（两个 goroutine，同一用户） | `likes` 一行；`like_count` = 1（不是 2） |
| 4 | 赞 → 踩 → 取消 → 取消 | `like_count` 1→0→0；`dislike_count` 0→1→0；四次都返回 200 |
| 5 | **并发改票**（同用户同时 PUT +1 与 -1） | 最终 `like_count + dislike_count = 1`；两个方向不可能同时留票 |
| 6 | 游客读主题列表 / 详情 / 回复 | `pending`/`rejected`/`hidden`/`deleted` 一个都不出现（**四条过滤路径各一个用例**） |
| 7 | 作者读自己的 `pending` 主题 | 详情 200、在 `/users/{me}/topics` 里出现、在他人的列表里不出现 |
| 8 | 游客搜不到待审主题 | `search` 返回 0 条（走 D5 的 JOIN，本域只提供数据） |
| 9 | 楼中楼只允许一级 | 回复顶层 → 201；回复那条楼中楼 → 400 `forum.reply_parent_nested` |
| 10 | 楼中楼跨主题 | 用另一个主题的顶层回复 id → 400 `forum.reply_parent_cross_topic` |
| 11 | 删回复 | `visibility=deleted`、`reply_count` -1、`last_reply_at` = 剩余最新回复；**再删一条直到只剩 1 楼 → `last_reply_at = created_at` 且不为 NULL** |
| 12 | 删主题 | 主题与全部楼层都 `deleted`；该主题的 likes 全没了；孤儿检查（§11.2 第 1 条）零行 |
| 13 | 删主题后搜索索引 | `topic_search` 里该行被删（跑一次任务处理函数再断言） |
| 14 | ACL 六步（表驱动，6 个用例） | 超管过 / 禁言拒绝 / `acl_enabled=false` 过 / deny 拒 / can 过 / 无行拒——**每条断言错误码**，不只断言"失败" |
| 15 | 禁言到期 | `until` 在过去 → 放行；在将来 → 403 且 `fields.until` 正确；`until IS NULL` → 永久 |
| 16 | 分区级 vs 全站禁言 | 分区 A 的禁言在分区 B 不生效；`board_id IS NULL` 的在任何分区都生效 |
| 17 | 拉黑双向 | A 拉黑 B 后 B 回复 A 的主题 → 403；A 自己回自己的主题 → 200；B **仍然能读** A 的主题 |
| 18 | `min_post_level` | level 不足 → 403 `forum.level_too_low`；够 → 201 |
| 19 | 转链端点 | 302 的 `Location` 正确；`go_count` 缓冲 +1（`counter.Get`）；不可见主题的源 → 404；越限 → 429 |
| 20 | Issue 取号 | 并发两条 Issue → `number` 1 与 2；`uq_post_issues_topic_number` 不报 |
| 21 | Issue 状态开关 | 关闭两次都 200；`closed_at` 在第一次时写入；重开后 `closed_by/closed_at` 都 NULL |
| 22 | `issue_open_count` | 3 开 1 关 → 3；关一条 → 2（只在 topic 详情里，不发额外请求） |
| 23 | 游标到底 | 恰好好 limit 条时 `next_cursor` 非空，再翻一页返回 0 行且 `next_cursor=null` |
| 24 | 游标损坏 | `cursor=abc` → 400 `common.invalid_input`；`cursor` 的 `k` 与 `sort` 不匹配 → 400 |
| 25 | 编辑不动 `last_reply_at` | 编辑 1 楼正文 → `updated_at` 前进、`last_reply_at` 不变；搜索索引任务被投递 |
| 26 | 移动分区清置顶 | `board_id` 变化后 `pinned_at IS NULL` |
| 27 | 分区分页不漏不重（10 页 × 20 条，全程用 `next_cursor`） | 翻完得到的 id 集合 = 一次性全查的集合，无重复 |

### 11.4 索引 vs 查询的「逐字一致」检查（会静默退化的那一类）

| # | 用例 | 断言 |
|---|---|---|
| 1 | `lower(username)` 表达式索引 | Q10 的 `?author=` 用 `lower(a.username) = lower($3)` 时走 `uq_users_username_lower`；写成 `a.username = $3` 时**不走**（把它写成一个断言，防止有人"顺手简化"） |
| 2 | `NULLS LAST` 的方向 | Q1 的 `ORDER BY ... DESC NULLS LAST` 与 `idx_topics_recent` 的声明逐字一致（`pg_get_indexdef` 取出来做字符串包含断言） |
| 3 | 第一页哨兵 | 用 `NULL` 当 `$3` 时**返回 0 行**——把"为什么必须用 infinity"变成一条会红的测试，而不是一条注释 |

### 11.5 需要人工看图的（不属于本域，但本域会提供数据）

分区页「一屏 ≥4 卡片」的验收（`设计需求-分区页.md` §F）依赖 Q1/Q2a 的字段完备性：`excerpt` / `cover_width` / `cover_height` 缺任何一个都会让卡片塌掉。**索引不由本域验收，字段必须齐。**

---

## 12. 与旧文档的冲突、回写清单、未决问题

### 12.1 本域裁决（与旧文档冲突，**以本文为准**）

| # | 冲突 | 旧文档说 | 本域定案 | 理由 |
|---|---|---|---|---|
| 1 | `topics.status` 一列 | 数据库文档 §4.2：`status text ck (normal,locked,hidden,deleted,pending,rejected)` | **拆成三列**：`visibility` / `review_state` / `locked_at` | 拍板 §2.2 已定两轴独立；`locked` 不是可见性，混在一起会出现「锁定的帖查不到」这种非法组合（盲审-数据库建模第 138 行点名的就是这条） |
| 2 | `topics.last_reply_at` | 数据库文档：`timestamptz NULL` | **NOT NULL**，插入时 = 1 楼 `created_at` | 拍板 §5.1 的 `NULLS LAST` 在行比较里要三分支特判；列非空后特判消失，索引里的 `NULLS LAST` 变成无害的空操作 |
| 3 | `topics` 的索引 | 数据库文档 §4.2 的 4 个（两个带 `pinned_at`、一个 `board_kind`） | **全部替换**为 §3.1 的 8 个 | 带 `pinned_at` 的排序键会让置顶帖在每页重复（§0 结论 3）；`idx_topics_board_kind` 的列序服务不了 `?kind=` 的筛选（盲审-数据库建模第 12/13 行点名） |
| 4 | `posts.status` | 数据库文档 §4.2：`ck (normal,deleted,hidden)` | 改名 `visibility`（同值域） | 与 topics 用同一个词，避免「status 在这张表是可见性、在那张表是审核态」 |
| 5 | 楼层的审核态 | 拍板 §2.2 第 3 条确认「不要在 posts 上再存一份审核态」 | 采纳，**posts 没有 review_state** | — |
| 6 | `post_issues.status` | 数据库文档 §4.11 与 `界面施工` §3.1 都用 `open` / `closed` | **`keep_open` / `closed`** | 拍板 §6 最后一行的原文就是 `status='keep_open'`。API 侧仍收 `?status=open` / `?status=closed`，换算只在一处（§7.7） |
| 7 | `post_issues.kind` | 数据库文档 / 方案 §20.2：三项 `bug` `feature` `other` | **四项**，加 `difficulty` | `界面施工` §3.2：本社区「难度建议」是独立一类 |
| 8 | `topic_sources` 的形状 | 数据库文档 §4.2：`(topic_id, label, url, code, sort)`；`界面施工` §2.2 初版：`provider` 只有 `netdisk` / `github` | **加 `provider` / `upkeep` / `size_text` / `go_count` / `verified_at` / `public_id`**；provider 是开放小集合 | 2026-10-12 需求变更（mcmod 式 logo 排 + 废弃 GitHub 镜像探测）。没有 `provider` 就没法查图标，没有 `upkeep` 就没法表达「已归档」 |
| 9 | `likes.target_type` | 数据库文档 §4.11：扩展到 `topic` / `post` / `issue` / `issue_comment` | 采纳 | 拍板 §3 的「投票复用 likes」要求 issue 与 issue 评论走同一张表 |
| 10 | `sanctions.board_id` | 数据库文档 §4.3：`bigint NULL`（NULL = 全局） | 采纳列定义，索引保持普通索引 | 拍板 §1.5 写的是「`board_id = 0` 或该分区」，而 0 会被外键拒绝——用 NULL 表达同一件事 |
| 11 | `likes` 的计数列 | 数据库文档 §4.2 的 posts 只有 `like_count` | **加 `dislike_count`** | 拍板 §3 的两个计数 + `my_vote` |
| 12 | `bookmarks` 的索引 | 数据库文档 §4.3：`(user_id, created_at DESC)` | 补 `id DESC` | 游标要 id 兜底（拍板 §5.1） |
| 13 | 「谁关 Issue」 | `界面施工` §3.5 建议非作者走 `topic.lock` | 采纳 | 与「锁主题」同一类动作，不新造权限点 |
| 14 | 分区统计 | 方案 §21.2 的 `GET /boards` 写了「含 cover、topic_count」 | 采纳字段，**不建计数列**（现算） | 三个统计列要挂在每次发帖/删帖/移动上，是新的漂移点（§1） |
| 15 | `topic_images` 的形状与归属 | D5 `d5-content.md` §4.1：主键 `(topic_id, image_hash)` + `sort smallint 0..8` + `uq_topic_images_sort`；写端点 `POST/DELETE /api/v1/topics/{id}/images` 归 media | **以 D5 为准**（本域不自建 `post_id`）。封面 = `sort = 0` | D5 那两个约束（`sort` 的范围与唯一）合起来回答了「封面是哪张」；本域再加一个 `post_id` 会让同一个问题有两个答案 |

### 12.2 需要回写旧文档的清单（**本轮不改旧文档**，只登记）

| # | 目标 | 改什么 |
|---|---|---|
| 1 | `数据库设计-postgresql.md` §4.2 | topics 的列清单换成 §2.1 的 DDL（三根轴 + `excerpt` + `client_token` + `last_reply_at` NOT NULL）；索引换成 §3.1 的 8 条 |
| 2 | `数据库设计-postgresql.md` §4.2 | posts 的 `status` → `visibility`，加 `client_token` / `dislike_count` |
| 3 | `数据库设计-postgresql.md` §4.2 | topic_sources 的列清单（加 provider / upkeep / size_text / go_count / verified_at / public_id） |
| 4 | `数据库设计-postgresql.md` §4.11 | post_issues：kind 四项、status `keep_open`，加 `number` / `assignee_id` / `tags` / `body_text` / `tsv`；issue_comments 加 `visibility` / `dislike_count` |
| 4b | `数据库设计-postgresql.md` §4.2 | **删掉 `topic_images：` 那一行**（表归 D5） |
| 4c | `d5-content.md` §4.1 / §4.2 | **无需改动**——本文与它对齐（封面 = `sort 0`、`cover_width/height` 走 `images.width/height`） |
| 5 | `数据库设计-postgresql.md` §4.3 | likes 的 target_type 四处、`updated_at`；「任一角色 deny」的说法作废（D6 新判定） |
| 6 | `数据库设计-postgresql.md` §3 表清单 | topics / post_issues 行的「关键索引」换成 §3.1 |
| 7 | `论坛后端技术方案-v2.md` §21.2 权限点 | `post.*` → `topic.*`（拍板 §7 已登记；本域的落点在 §9.3） |
| 8 | `论坛后端技术方案-v2.md` §21.2 论坛段 | 补 `GET /api/v1/issues`、`GET /topics/{id}/sources/{sid}/go`、`POST/PATCH/DELETE /topics/{id}/sources[/{sid}]`、`POST /topics/{id}/sources/{sid}/verify`、`GET /posts/{id}/replies`、`GET /issue-comments/{id}/replies`；删掉不存在的 `PUT /issues/{id}/comments`（§21.2 写的是 `GET/POST`） |
| 9 | `论坛后端技术方案-v2.md` §21.3 | 主题列表项补 `excerpt`；补 `sources[]` 的字段形状（provider 是开放 key、`go_path`、`size`、`upkeep`、`extraction_code`） |
| 10 | `界面施工-后端需求变动.md` §3.1.2 | 标注 `tags` 进 v1（`text[]` + GIN），`labels` 这个说法改名；`assignee` 只支持 `=me` |
| 11 | `数据库设计-postgresql.md` §12 自检清单 | 补 §11.2 的 7 条本域自检 |
| 12 | `数据库设计-postgresql.md` §4.4 images | 【若 12.3-1 选 A】加 `width` / `height` 两列 |

### 12.3 未决问题（每条给两种选择与代价，**不自己拍板**）

**12.3-1 ~~`images` 缺 `width` / `height`~~ —— 已核实不成立（D5 已经落库），本域改成依赖 D5**

- **已核实**：D5 `d5-content.md` §2.1 的 `images` 表**已有** `width int NOT NULL CHECK (width > 0)` / `height int NOT NULL CHECK (height > 0)`，§4.2 也把 `cover_width` / `cover_height` 写进对外响应。
- 结论：本域 §3.2 Q1 的 `i.width, i.height` 直接可用，**不需要任何额外迁移**。

**12.3-2 `topic_sources.provider` 要不要 CHECK**

- A（本文的选择）：有 CHECK，12 个已知值。代价：加一个网盘站要一条迁移。
- B：不设 CHECK，任何小写 key 都收。代价：`Baidu` / `百度` 这类值会让前端回落成通用图标（一排问号），而且发现时已经写进库了。
- **倾向 A**：前端加图标映射与后端加 CHECK 是同一个人的同一次改动。

**12.3-3 `idx_posts_roots` 要不要现在就建**

- A：现在就建 `(topic_id, id) WHERE parent_id IS NULL`，代价是一个部分索引的写放大。
- B（本文的选择）：先不建，等 §11.1 第 6 条的 EXPLAIN 断言显示出「Rows Removed by Filter 远大于返回行」再加——那是一条迁移，不改代码。

**12.3-4 「我发过的回复」没有端点**

- `posts.idx_posts_author` 现在只服务外键检查（删用户路径）。
- A：如果个人主页最终要有「我的回复」标签，它顺带就有了查询；B：确认不做，索引仍必须留着（外键检查要求）。
- **本设计按 A 预留索引，端点不做**（拍板 §0：不写没人调的导出）。

**12.3-5 评论的 `?sort=hot`**

- 现状：后端只按 `id DESC`（最新）；「最热 / 最新」是 `@/ui/comment` 在同一页数据上的前端排序（`comment-list.tsx` 第 29 行）。
- A（本文的选择）：不做 `sort=hot`。热排序没有稳定游标（跨页重复），当前页内前端排一次是免费的。
- B：做 `sort=hot|latest`，热排序只允许首页（带游标 → 400）。代价：多一处「热」的定义，且可能与前端排序口径不一致。
- **如果 W2 的「最热」实际上要跨页**（用户期望"最热的评论出现在前 20 条里"），A 就是错的，必须转 B。**这条要问界面。**

**12.3-6 `min_post_level = 1` 等于「不限」**

- `level = floor(sqrt(exp/100)) + 1`，`exp=0` 时 level=1，所以门槛设 1 与设 0 等价。
- A：接受（后台界面上写一句提示）。B：门槛改成「需要 exp ≥ N」——代价是与 `users.level` 这个既有概念分叉。

**12.3-7 `bookmark_count` 要不要返回**

- 现状：前端 `TopicDetail` 里有 `bookmark_count`，本域**不返回它**（只给 `viewer.bookmarked`）。
- A（本文的选择）：不返回。要真返回就得建 `idx_bookmarks_topic (topic_id)`——`idx_bookmarks_user` 的第二列服务不了它。
- B：返回并补该索引。**倾向 A**；如果 W2 的图上真有这个数字，转 B 并补索引。

**12.3-9 发主题时的配图：要不要在发帖事务里挂图**

- 现状：方案 §21.2 的端点表里有两个形状同时存在——`POST /api/v1/topics` 的 body 有 `images[]`，而 `POST /api/v1/posts/{id}/images` 又是一条独立端点（D5 §2.2 把 `topic_images` 的写入时机定在后者）。
- A（倾向）：**只保留独立端点**。发帖成功后前端把已上传的图逐张挂到 `/posts/{id}/images`。代价：用户在第 2 张贴图失败时会得到一个没有图但已经发出的帖子（可接受：正文还在，重试贴图即可），以及网络上若干"已上传却没人引用"的图 —— 它们的 `refcount` 为 1（上传时加过了），由 D5 §2.2 的时机表与对账 SQL 兜。
- B：`CreateTopic` 收 `images[]`，在同一事务里挂图。代价：一次图片引用失败会把整个发帖回滚，用户丢的是帖子；而且发帖事务里要**跨域调用 D5 的表写入**，与「引用行在谁的表里谁负责」的分工正好相反。
- **两条都要改 D5 或 §21.2 的一处文本**，所以它需要 Lead 定。本文的 §4.2 按 A 写。

**12.3-8 `issue_comments` 要不要 `number`**

- A（本文的选择）：评论不编号（GitHub 也不给评论编号）。B：加编号——多一处取号事务，换不到界面表达能力。

---

## 13. 自检：本文 SQL 的可执行性验证

本域的全部 DDL（50 条语句）与全部查询都用 **`pglast`（libpg_query 8.5，真 PG 语法树）** 逐条解析通过：

```bash
python -m pip install pglast
python -c "from pglast import parse_sql; import sys; src=open(sys.argv[1],encoding='utf-8').read(); print('OK', len(parse_sql(src)))" ddl.sql
```

**解析通过 ≠ 语义正确**。以下三类只能靠真库跑，本文逐条要求它们是 §11.1 的断言项，而不是「运行时再说」：

| 类别 | 例子 | 谁来证明 |
|---|---|---|
| 生成列的 IMMUTABLE | `to_tsvector('simple', …)` 与 `setweight` 在 `post_issues.tsv` 上能否建 | §11 的迁移测试（空库 → 全部迁移） |
| 部分索引的谓词 | `visibility='normal'` / `client_token <> ''` / `review_state <> 'approved'` 都只引用列 | 同上（建不出来会直接报错） |
| 计划是否走索引 | §3 的每一条查询 | §11.1 的 12 条 EXPLAIN 断言 |

**本机没有 PostgreSQL、也没有 Docker**（数据库文档 §9 已核实），所以本文没有实测计划——**EXPLAIN 断言是设计的一部分，不是可选项**。

---

## 14. 四个问题（逐条回答）

**① boards：slug 唯一、sort、cover_hash、acl_enabled、发帖门槛**
→ §2.1 的 DDL。分区列表 `ORDER BY sort, id`（`idx_boards_sort`）；分区详情一次拿全现算的三个统计（§3.3 Q2e）；
`acl_enabled` 默认 false = 登录即可发言（拍板 §1.5 第 3 步）；门槛 `min_post_level` 在 `canSpeak` 的最后一步判（§6.4）。

**② topics：三类 kind、两条独立轴、pinned/featured、last_reply_at 的维护时机、三个计数列**
→ §2.2（逐列语义）。`last_reply_at` 三条写路径：建主题 = 1 楼时间、加回复 = 回复时间、删回复 = 剩余最新（§4.4 / §4.6）；
计数：`reply_count` 同事务重算、`like_count` 同事务增量、`view_count` 走 counter 缓冲（§8.1 的分界线）。

**③ 四条列表的完整游标 SQL**
→ §3.2 首页（索引 a）、§3.3 分区页（索引 b/c/d/f/g + 置顶单独查询）、§3.5 个人主页（索引 e，两条：直接翻页与一跳图遍历）、§3.6 收藏页（索引 k）。
四条都用 `(k, id) < (?, ?)` 行比较、第一页哨兵 `infinity` + `MaxInt64`、游客过滤 `visibility='normal' AND review_state='approved'`。

**④ 发帖/回复/编辑/删除的事务边界、client_token 幂等、软删语义、楼中楼校验位置、拉黑与禁言的判定顺序**
→ §4.1（判定顺序 + 为什么不能挪）、§4.2（发主题的六步事务）、§4.3（幂等：唯一部分索引 + 插入失败回查）、
§4.5（编辑的副作用）、§4.6（三种软删的确切语义与计数重算）、§4.1.1 末段（拉黑只在「回复别人的内容」时判，双向任一命中即拒，且不说是谁）、
§6.3（禁言在 `canSpeak` 第 2 步，覆盖五条写路径，编辑/删除不在其中）。
