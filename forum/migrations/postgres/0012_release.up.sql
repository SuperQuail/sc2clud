-- 0012_release.up.sql —— 下载（启动器索引，不存字节）
-- 依据：d1-platform §8.1 编号；d5-content §5.1（DDL 真源）；数据库文档 §2 全局约定、§4.7。
-- 表名/列名/索引名遵循数据库文档 §2 第 1 条：idx_ / uq_ / ck_ / fk_。

-- ============================================================
-- releases：一个版本一行（版本号全局唯一，平台差异在 assets）
-- ============================================================
CREATE TABLE releases (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id    uuid        NOT NULL UNIQUE,
  version      varchar(32) NOT NULL UNIQUE,       -- 全局唯一（拍板 §8.9）：同号两通道会让人下错
  channel      text        NOT NULL DEFAULT 'stable',
  notes_md     text        NOT NULL DEFAULT '',
  notes_html   text        NOT NULL DEFAULT '',   -- goldmark + bluemonday，与帖子同一套
  published_at timestamptz NULL,                  -- 只有 published 非空（d5 §5.4 状态机的前提）
  status       text        NOT NULL DEFAULT 'draft',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_releases_channel CHECK (channel IN ('stable','beta')),
  CONSTRAINT ck_releases_status  CHECK (status  IN ('draft','published','archived')),
  -- 状态机的不变量：published_at 非空 ⟺ status = 'published'（d5 §5.4「只有 published 有非空 published_at」）
  CONSTRAINT ck_releases_published_at
    CHECK ((status =  'published' AND published_at IS NOT NULL) OR
           (status <> 'published' AND published_at IS NULL))
);

-- 「最新 stable」（LIMIT 1）与「历史版本列表」（游标分页）共用这一条：
-- status 等值 + channel 可选等值 + published_at DESC, id DESC（与拍板 §5.1 的排序键同序）
CREATE INDEX idx_releases_latest ON releases (status, channel, published_at DESC, id DESC);

-- ============================================================
-- release_assets：外部直链 + 哈希（本站不存字节）
-- ============================================================
CREATE TABLE release_assets (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id      uuid        NOT NULL UNIQUE,
  release_id     bigint      NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  platform       varchar(16) NOT NULL,            -- windows / macos / linux（不做 CHECK：加平台不该改迁移）
  arch           varchar(16) NOT NULL,            -- x86_64 / arm64
  url            text        NOT NULL,
  size           bigint      NOT NULL DEFAULT 0,
  sha256         text        NOT NULL,
  download_count bigint      NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- 信任边界：管理员录入的外部直链。没有它，一条 javascript:/file: 就是开放重定向与协议走私
  CONSTRAINT ck_release_assets_url    CHECK (url ~ '^https?://'),
  CONSTRAINT ck_release_assets_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_release_assets_size   CHECK (size >= 0),
  CONSTRAINT ck_release_assets_count  CHECK (download_count >= 0)
);

CREATE UNIQUE INDEX uq_release_assets_slot    ON release_assets (release_id, platform, arch);
CREATE INDEX        idx_release_assets_release ON release_assets (release_id);   -- 外键索引（PG 不自动建）

-- 计数每 15 秒批量回写（d5 §5.2）：这两张表是持续更新的，收紧 autovacuum（盲审-运行 73）
ALTER TABLE release_assets SET (autovacuum_vacuum_scale_factor = 0.02,
                                autovacuum_vacuum_threshold    = 1000);
ALTER TABLE releases       SET (autovacuum_vacuum_scale_factor = 0.02,
                                autovacuum_vacuum_threshold    = 1000);
