-- 0004_forum：分区 / 分区 ACL / 主题 / 楼层 / 帖子配图 / 下载源
--
-- 依赖关系（按序号顺序执行，先建被引用的表）：
--   boards.cover_hash → images（0002）；board_acls.role_id → roles（0002）；
--   topics.board_id → boards、topics.author_id/reviewed_by → users（0002/0003）；
--   posts.topic_id → topics、posts.parent_id → posts；topic_images → topics/posts/images。
-- board_moderators（0003）引用 boards，那条外键在**本文件末尾**补上 —— 它建表时 boards 还不存在。
--
-- 与旧文档差异（以拍板为准）：
--   * 主题的可见性/审核态是**两根独立的轴**（拍板 §2.2）：topics.visibility 与 topics.review_state，
--     不再有数据库设计 §4.2 里那个把六种状态塞成一列的 status。
--   * topics.kind 三类、topic_sources.provider 是开放小集合（拍板 §8.10）。

-- ============================================================
-- boards（分区；表驱动，新增分区零代码改动）
-- ============================================================
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
  CONSTRAINT ck_boards_status         CHECK (status IN ('active','archived')),
  CONSTRAINT ck_boards_min_post_level CHECK (min_post_level >= 0)
);

CREATE INDEX idx_boards_sort  ON boards (sort, id);
CREATE INDEX idx_boards_cover ON boards (cover_hash);   -- FK：SET NULL

-- ============================================================
-- board_acls（D6 判定顺序的落点：deny 优先，白名单制）
-- ============================================================
CREATE TABLE board_acls (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；自然键降为唯一约束
  board_id   bigint      NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  role_id    bigint      NOT NULL REFERENCES roles(id)  ON DELETE CASCADE,
  can_post   boolean     NOT NULL DEFAULT false,
  can_reply  boolean     NOT NULL DEFAULT false,
  deny_post  boolean     NOT NULL DEFAULT false,
  deny_reply boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, role_id),
  CONSTRAINT ck_board_acls_no_contradiction
    CHECK (NOT (deny_post AND can_post) AND NOT (deny_reply AND can_reply))
);

CREATE INDEX idx_board_acls_role ON board_acls (role_id);   -- 复合主键第二列不算已索引

-- ============================================================
-- topics
-- ============================================================
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
  reviewed_by     bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
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
  CONSTRAINT ck_topics_kind                CHECK (kind IN ('discussion','resource','repost')),
  CONSTRAINT ck_topics_visibility          CHECK (visibility IN ('normal','hidden','deleted')),
  CONSTRAINT ck_topics_review_state        CHECK (review_state IN ('pending','approved','rejected')),
  CONSTRAINT ck_topics_resource_status     CHECK (resource_status IS NULL
                                                  OR resource_status IN ('maintained','bugfix_only','unmaintained')),
  CONSTRAINT ck_topics_resource_status_kind CHECK (resource_status IS NULL OR kind = 'resource'),
  CONSTRAINT ck_topics_counts_nonneg       CHECK (reply_count >= 0 AND like_count >= 0 AND view_count >= 0),
  CONSTRAINT ck_topics_deleted_no_pin      CHECK (visibility <> 'deleted'
                                                  OR (pinned_at IS NULL AND featured_at IS NULL))
);

-- 列表索引：列序与游标排序键逐字同序（拍板 §5.1/§5.9 第 4 条）。
-- 谓词只引用列（visibility），时间比较与 review_state 的判定留在查询里。
CREATE INDEX idx_topics_recent     ON topics (last_reply_at DESC NULLS LAST, id DESC)
  WHERE visibility = 'normal';
CREATE INDEX idx_topics_board_live ON topics (board_id, last_reply_at DESC NULLS LAST, id DESC)
  WHERE visibility = 'normal';
CREATE INDEX idx_topics_board_new  ON topics (board_id, created_at DESC, id DESC)
  WHERE visibility = 'normal';
CREATE INDEX idx_topics_kind_new   ON topics (kind, created_at DESC, id DESC)
  WHERE visibility = 'normal';
CREATE INDEX idx_topics_featured   ON topics (featured_at DESC, id DESC)
  WHERE visibility = 'normal' AND featured_at IS NOT NULL;
CREATE INDEX idx_topics_pinned     ON topics (board_id, pinned_at DESC, id DESC)
  WHERE visibility = 'normal' AND pinned_at IS NOT NULL;
CREATE INDEX idx_topics_review_queue ON topics (review_state, created_at DESC, id DESC)
  WHERE review_state <> 'approved';
CREATE INDEX idx_topics_author     ON topics (author_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX uq_topics_author_client_token ON topics (author_id, client_token)
  WHERE client_token <> '';
-- 纯外键索引（不是给查询用的）：上面两条针对 board_id / reviewed_by 的索引都带谓词，
-- 引用完整性查找用不了部分索引，删分区/删审核人时会全表扫（数据库文档 §12 第 1 条）。
CREATE INDEX idx_topics_board_id    ON topics (board_id);
CREATE INDEX idx_topics_reviewed_by ON topics (reviewed_by);

-- ============================================================
-- posts（楼层；1 楼 = 主题正文）
-- ============================================================
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
  CONSTRAINT ck_posts_floor          CHECK (floor >= 1),
  CONSTRAINT ck_posts_visibility     CHECK (visibility IN ('normal','hidden','deleted')),
  CONSTRAINT ck_posts_counts_nonneg  CHECK (like_count >= 0 AND dislike_count >= 0)
);

CREATE UNIQUE INDEX uq_posts_topic_floor ON posts (topic_id, floor);
CREATE INDEX idx_posts_topic_id  ON posts (topic_id, id);          -- 楼层游标分页
CREATE INDEX idx_posts_author    ON posts (author_id);             -- FK：RESTRICT 也要扫
CREATE INDEX idx_posts_parent    ON posts (parent_id);             -- 楼中楼 + FK（不能是部分索引）
CREATE INDEX idx_posts_author_client_token ON posts (author_id, client_token)
  WHERE client_token <> '';

-- ============================================================
-- topic_images（帖子配图关联；封面由本表派生，不存列）
-- ============================================================
CREATE TABLE topic_images (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；自然键降为唯一约束
  topic_id   bigint      NOT NULL REFERENCES topics(id)     ON DELETE CASCADE,
  post_id    bigint      NOT NULL REFERENCES posts(id)      ON DELETE CASCADE,
  image_hash char(64)    NOT NULL REFERENCES images(hash)   ON DELETE RESTRICT,
  sort       int         NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, post_id, image_hash),
  CONSTRAINT ck_topic_images_sort CHECK (sort BETWEEN 0 AND 8)
);

-- 主键同时是封面查询的索引（topic_id 等值 + post_id 前缀）。
-- 复合主键的第二列/第三列不算已索引：删楼层要扫 post_id，删图片要扫 image_hash。
CREATE INDEX idx_topic_images_post ON topic_images (post_id);
CREATE INDEX idx_topic_images_hash ON topic_images (image_hash);
CREATE UNIQUE INDEX uq_topic_images_sort ON topic_images (topic_id, post_id, sort);

-- ============================================================
-- topic_sources（资源帖的下载源；provider 是开放小集合，图标由前端按 key 查）
-- ============================================================
CREATE TABLE topic_sources (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid         NOT NULL UNIQUE,   -- 转链端点靠它寻址（拍板 §5.6：自增 id 不出 API）
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
  CONSTRAINT ck_topic_sources_url    CHECK (url ~ '^https?://'),
  CONSTRAINT ck_topic_sources_upkeep CHECK (upkeep IN ('active','archived')),
  CONSTRAINT ck_topic_sources_size   CHECK (size_text = '' OR size_text ~ '^[0-9]+([.][0-9]+)? ?(B|KB|MB|GB|TB)$'),
  CONSTRAINT ck_topic_sources_code   CHECK (extraction_code IS NULL OR extraction_code ~ '^[A-Za-z0-9]{1,16}$'),
  CONSTRAINT ck_topic_sources_count  CHECK (go_count >= 0)
);

CREATE INDEX idx_topic_sources_topic ON topic_sources (topic_id, sort, id);

-- ============================================================
-- 补 0003 欠下的外键：board_moderators.board_id → boards
-- ============================================================
ALTER TABLE board_moderators ADD CONSTRAINT fk_board_moderators_board
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE;
