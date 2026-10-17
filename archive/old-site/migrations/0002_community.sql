-- ============================================================
-- 0002 社区基建：角色与激活、帖子类型与审核、图片管线、站点设置、审计
--
-- 权限模型（自低到高）：未激活用户 < 普通用户 < 认证开发者 < 网站管理员 < 超级管理员
--   * 未激活 = users.activated_at IS NULL（可以登录，但不能发帖/回复/上传）
--   * 角色   = users.role ∈ member | developer | admin | super
-- 帖子类型：discussion（普通讨论）/ resource（资源，开发者+）/ repost（转载资源，普通用户可发）
-- 审核：所有帖子过审核机；auto 通过的占绝大多数；pending 仍然可见（暂时不卡），只有 rejected 隐藏。
-- ============================================================

-- ---------- 激活状态 ----------
ALTER TABLE users ADD COLUMN activated_at INTEGER;
ALTER TABLE users ADD COLUMN activated_by INTEGER;
-- 早期脚手架用户（demo / 已注册者）默认视为已激活，避免升级后把自己锁在门外。
UPDATE users SET activated_at = created_at WHERE activated_at IS NULL;

-- ---------- 帖子：类型与审核 ----------
ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'discussion';
ALTER TABLE posts ADD COLUMN review_state TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE posts ADD COLUMN review_note TEXT;
ALTER TABLE posts ADD COLUMN reviewed_at INTEGER;
ALTER TABLE posts ADD COLUMN reviewed_by INTEGER;
ALTER TABLE posts ADD COLUMN auto_reviewed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_posts_feed ON posts(review_state, created_at DESC);

-- ---------- 帖子图片（仅主帖；回复不带图）----------
CREATE TABLE post_images (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL DEFAULT 0,
    original_hash  TEXT    NOT NULL,          -- 原图（内容寻址，永久保留）
    display_hash   TEXT,                      -- 压缩后展示图（异步生成前为 NULL）
    thumb_hash     TEXT,                      -- 缩略图
    width          INTEGER,
    height         INTEGER,
    original_bytes INTEGER NOT NULL,
    display_bytes  INTEGER,
    mime           TEXT    NOT NULL DEFAULT 'image/webp',
    state          TEXT    NOT NULL DEFAULT 'processing', -- processing | ready | failed
    created_at     INTEGER NOT NULL
);
CREATE INDEX idx_post_images_post ON post_images(post_id, position);

-- 图片处理队列：请求路径内绝不转码（2 核上同步转码会瞬间打满 CPU）
CREATE TABLE image_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id      INTEGER NOT NULL REFERENCES post_images(id) ON DELETE CASCADE,
    original_hash TEXT    NOT NULL,
    state         TEXT    NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_image_jobs_state ON image_jobs(state, id);

-- ---------- 站点设置（超级管理员可改）----------
CREATE TABLE settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER
);
-- 是否要求手动激活：1 = 注册后需管理员激活（默认），0 = 注册即可用
INSERT INTO settings (key, value, updated_at, updated_by)
VALUES ('registration.require_activation', '1', strftime('%s','now'), NULL);

-- ---------- 审计 ----------
CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   INTEGER,
    action     TEXT    NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
