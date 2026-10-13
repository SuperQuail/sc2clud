-- 0002_accounts：账号域的核心 + 它必须先于 users 存在的基础表
--
-- 【本文件的表与 d1-platform.md §8.1 的归属说明】
-- §8.1 把 0002 标成 "users / sessions / email_tokens"，把 roles / permissions / images 分别标给
-- 0003 与 0010。但 PostgreSQL 的外键要求被引用的表**必须先存在**，而 users 同时引用
-- roles(id)（NOT NULL RESTRICT）、titles(id)（equipped_title_id）、images(hash)（头像三列），
-- 于是出现了环：users → roles/images 与 titles.user_titles → users。
-- 破环的办法只有两种：① 把被引用的表提前到 0002；② 把这些列连同外键推迟到后面的迁移里 ALTER。
-- 这里两个都用：**表与它的普通索引留在 §8.1 指定的那一份**，只有「被 users 引用的三张表」
-- （roles / permissions / role_permissions / images）提前到 0002；titles 无法提前（它自己引用 users），
-- 所以 users.equipped_title_id 在 0009_title 里 ALTER 补上。
-- 授权域的其余四张表（user_permissions / audit_logs / board_moderators / 以及 sessions /
-- email_tokens 之外的）仍在 0003_authz，与 §8.1 一致。
--
-- 全局约定逐条遵守（数据库设计-postgresql.md §2）：identity 主键、public_id 由应用生成（DB 无默认）、
-- 时间一律 timestamptz、枚举一律 text + CHECK、布尔 NOT NULL DEFAULT false、外键显式建索引、
-- 每表 created_at、有业务上限的文本用 varchar(n)。

-- ============================================================
-- roles（授权域；提前到此处：users.role_id NOT NULL 引用它）
-- ============================================================
CREATE TABLE roles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         varchar(32)  NOT NULL UNIQUE,
  name        varchar(32)  NOT NULL,
  description varchar(200) NOT NULL DEFAULT '',
  parent_id   bigint       NULL REFERENCES roles(id) ON DELETE RESTRICT,
  depth       int          NOT NULL DEFAULT 0,
  badge_color varchar(16)  NULL,
  is_system   boolean      NOT NULL DEFAULT false,
  is_super    boolean      NOT NULL DEFAULT false,
  priority    int          NOT NULL DEFAULT 0,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_roles_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT ck_roles_depth_nonneg   CHECK (depth >= 0)
);

CREATE INDEX idx_roles_parent ON roles (parent_id);                          -- FK：删父角色要扫子表
CREATE UNIQUE INDEX uq_roles_super ON roles (is_super) WHERE is_super;       -- 全库只有一个超管角色

-- ============================================================
-- permissions（授权域；提前理由同 roles）
-- ============================================================
CREATE TABLE permissions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         varchar(64)  NOT NULL UNIQUE,
  grp         varchar(32)  NOT NULL,
  name        varchar(32)  NOT NULL,
  description varchar(200) NOT NULL DEFAULT '',
  created_at  timestamptz  NOT NULL DEFAULT now()
);

-- ============================================================
-- role_permissions
-- ============================================================
CREATE TABLE role_permissions (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  role_id       bigint      NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
  permission_id bigint      NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_id)   -- 原自然键：降为唯一
);

-- 复合主键的第二列不算「已索引」（数据库文档 §12 第 1 条），删权限点时要扫这一列
CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);

-- ============================================================
-- images（媒体域，内容寻址；提前理由同 roles —— users 的三根头像列引用它）
-- ============================================================
CREATE TABLE images (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  hash        char(64)    UNIQUE,   -- 原自然键：降为唯一
  size        bigint      NOT NULL,
  mime        text        NOT NULL,
  width       int         NOT NULL DEFAULT 0,
  height      int         NOT NULL DEFAULT 0,
  refcount    int         NOT NULL DEFAULT 1,
  visibility  smallint    NOT NULL DEFAULT 0,
  owner_id    bigint      NULL,                      -- FK 在 0003_authz 补（users 那时才存在）
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_images_hash_fmt   CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_images_size_pos   CHECK (size > 0),
  CONSTRAINT ck_images_mime       CHECK (mime IN ('image/png','image/jpeg','image/gif','image/webp')),
  CONSTRAINT ck_images_dims       CHECK (width >= 0 AND height >= 0),
  CONSTRAINT ck_images_refcount   CHECK (refcount >= 0),
  CONSTRAINT ck_images_visibility CHECK (visibility IN (0,1,2))
);

-- GC 任务只扫「引用归零」的行；部分索引只引用列，谓词合法（拍板 §5.9 第 1 条）
CREATE INDEX idx_images_gc ON images (refcount) WHERE refcount = 0;

-- ============================================================
-- default_avatars（默认头像池）
-- ============================================================
CREATE TABLE default_avatars (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  hash       char(64)    UNIQUE REFERENCES images(hash) ON DELETE CASCADE,   -- 原自然键：降为唯一
  sort       int         NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- users（全新设计，不是旧表复制）
-- ============================================================
CREATE TABLE users (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id           uuid         NOT NULL UNIQUE,
  username            varchar(32)  NOT NULL,
  email               varchar(254) NOT NULL,
  password_hash       text         NOT NULL,
  nickname            varchar(20)  NOT NULL,
  bio                 varchar(200) NOT NULL DEFAULT '',
  avatar_hash         char(64)     NULL REFERENCES images(hash) ON DELETE SET NULL,
  avatar_small_hash   char(64)     NULL REFERENCES images(hash) ON DELETE SET NULL,
  -- default_avatar_hash 不在这里，在 0010_media（拍板 §8.8 / §9.11 U12）
  status              text         NOT NULL DEFAULT 'active',
  activation_pending  text         NULL,
  email_verified_at   timestamptz  NULL,
  activated_at        timestamptz  NULL,
  trusted             boolean      NOT NULL DEFAULT false,
  role_id             bigint       NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  equipped_title_id   bigint       NULL,               -- FK 在 0009_title 补（titles 那时才存在）
  exp                 int          NOT NULL DEFAULT 0,
  level               int          NOT NULL DEFAULT 1,
  last_login_at       timestamptz  NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_users_status             CHECK (status IN ('active','banned','deleted')),
  CONSTRAINT ck_users_activation_pending CHECK (activation_pending IN ('email','manual')),
  CONSTRAINT ck_users_exp_nonneg         CHECK (exp >= 0),
  CONSTRAINT ck_users_level_min          CHECK (level >= 1)
);

-- 大小写不敏感的唯一性用表达式唯一索引（数据库文档 §2 第 9 条）：
-- 查询必须写成 lower(username) = lower($1) 才走索引。
CREATE UNIQUE INDEX uq_users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX uq_users_email_lower    ON users (lower(email));

-- idx_users_nickname_lower（昵称前缀搜索）不在这里，在 0009_title —— 那个编号本来就要给
-- titles/user_titles/exp_events 补 users 的列，顺手把这条索引放在同一个文件里。

-- 后台用户列表游标（拍板 §5.1：排序键带 id 兜底，索引列序与游标同序）
CREATE INDEX idx_users_created_at ON users (created_at DESC, id DESC);
-- 纯外键索引（数据库文档 §12 第 1 条的自检没有排除名单，不加就红）
CREATE INDEX idx_users_role           ON users (role_id);
CREATE INDEX idx_users_avatar         ON users (avatar_hash);
CREATE INDEX idx_users_avatar_small   ON users (avatar_small_hash);
