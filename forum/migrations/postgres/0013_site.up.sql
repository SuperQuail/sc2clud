-- 0013_site.up.sql —— 站点：键值 / 域名白名单 / 公告 / 横幅
-- 依据：d1-platform §8.1；d6-reward §3.2 的 DDL（真源）；数据库文档 §2 全局约定、§4.9；
--       拍板 §8.11 U2（site_domains 不要 is_primary）、U10（banner_roles 无行 = 所有人）。

-- ============================================================
-- 1) site_settings：站点键值（key 必须在代码表里，否则 400）
-- ============================================================
CREATE TABLE site_settings (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  key        varchar(64) UNIQUE,   -- 原自然键：降为唯一
  value      text        NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 不预置任何行：缺 key = 用代码里的默认值（d6 §5.4）。插空行会让「默认值」有两个真源。
-- 无 created_at：配置表（d6 §631 已定案按「配置表不适用」处理）。

-- ============================================================
-- 2) site_domains：域名白名单
-- ============================================================
CREATE TABLE site_domains (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  domain     varchar(253) UNIQUE,   -- 统一存 lower() 形式，写入时归一化   -- 原自然键：降为唯一
  created_at timestamptz  NOT NULL DEFAULT now()
);
-- 没有 is_primary：真源是配置里的 site.base_url（拍板 §8.11 U2）

-- ============================================================
-- 3) announcements：公告
-- ============================================================
CREATE TABLE announcements (
  id           bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id    uuid         NOT NULL UNIQUE,
  title        varchar(120) NOT NULL,
  body_md      text         NOT NULL,
  body_html    text         NOT NULL,
  enabled      boolean      NOT NULL DEFAULT true,
  published_at timestamptz  NULL,          -- NULL = 草稿
  created_by   bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);
-- 部分索引：只索引会出现在首页的公告（草稿与停用的不进索引）。
-- 谓词只引用列（拍板 §5.9 第 1 条）：「生效中」的时间比较留在查询里。
CREATE INDEX idx_announcements_published  ON announcements (published_at DESC, id DESC)
  WHERE enabled AND published_at IS NOT NULL;
CREATE INDEX idx_announcements_created_by ON announcements (created_by);   -- 外键索引

-- ============================================================
-- 4) banners：顶部横幅
-- ============================================================
CREATE TABLE banners (
  id         bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id  uuid         NOT NULL UNIQUE,
  kind       text         NOT NULL,
  text       varchar(200) NOT NULL,
  url        text         NULL,
  starts_at  timestamptz  NOT NULL DEFAULT now(),
  ends_at    timestamptz  NULL,
  enabled    boolean      NOT NULL DEFAULT true,
  created_by bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_banners_kind   CHECK (kind IN ('info','warning','promo')),
  CONSTRAINT ck_banners_window CHECK (ends_at IS NULL OR ends_at > starts_at)
);
-- 谓词只能是列：WHERE enabled AND now() BETWEEN starts_at AND ends_at 建不出来（拍板 §5.9 第 1 条）。
-- 索引给的是候选集，生效窗口由查询自己判：WHERE enabled AND starts_at <= $1 AND (ends_at IS NULL OR ends_at > $1)
CREATE INDEX idx_banners_active     ON banners (starts_at, ends_at) WHERE enabled;
CREATE INDEX idx_banners_created_by ON banners (created_by);   -- 外键索引

-- ============================================================
-- 5) banner_roles：横幅按角色定向（无行 = 所有人，拍板 §8.11 U10）
-- ============================================================
CREATE TABLE banner_roles (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  banner_id bigint NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
  role_id   bigint NOT NULL REFERENCES roles(id)   ON DELETE CASCADE,
  UNIQUE (banner_id, role_id)   -- 原自然键：降为唯一
);
-- 复合主键的第二列不算「已索引」（数据库文档 §12 第 1 条）：删角色要扫子表，补单列索引
CREATE INDEX idx_banner_roles_role ON banner_roles (role_id);

-- ============================================================
-- 6) banner_dismissals：不再显示
-- ============================================================
CREATE TABLE banner_dismissals (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  banner_id  bigint      NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
  user_id    bigint      NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (banner_id, user_id)   -- 原自然键：降为唯一
);
-- 「我关过哪些横幅」按 (user_id, banner_id) 反查 → 方向与主键相反的额外唯一索引
CREATE UNIQUE INDEX uq_banner_dismissals_user ON banner_dismissals (user_id, banner_id);
