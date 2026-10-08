-- ============================================================
-- 0005 帖子分区 + 资源来源
--
-- 分区（先做四个基础分区，够用再细化）：
--   vanilla_mod      原版战役 mod
--   custom_campaign  自制战役
--   tool_player      工具（玩家用）
--   tool_dev         工具（开发者用）
--
-- 资源来源：一篇资源帖可以有多个下载来源（国内网盘 / GitHub / 直链），
--   每个来源记 provider + url + 提取码；GitHub 来源在页面上额外给镜像跳转。
-- ============================================================

ALTER TABLE posts ADD COLUMN section TEXT NOT NULL DEFAULT 'custom_campaign';
CREATE INDEX idx_posts_section ON posts(section, review_state, created_at DESC);

CREATE TABLE post_sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL DEFAULT 0,
    provider     TEXT    NOT NULL,              -- baidu | quark | aliyun | lanzou | 123pan | weiyun | github | direct
    label        TEXT,                          -- 可选的显示名，如「完整包」「补丁」
    url          TEXT    NOT NULL,
    extract_code TEXT,                          -- 网盘提取码
    created_at   INTEGER NOT NULL
);
CREATE INDEX idx_post_sources_post ON post_sources(post_id, position);
