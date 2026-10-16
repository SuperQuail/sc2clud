-- ============================================================
-- 0013 后端扩展：横幅 / 资源帖状态 / 收款码
-- 纯加法，可在生产安全执行。
-- ============================================================

-- 横幅：对登录用户展示；点过「确认」的用户不再看到（banner_dismissals）。
CREATE TABLE IF NOT EXISTS banners (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    kind       TEXT    NOT NULL DEFAULT 'info',   -- info | warning | promo
    url        TEXT,                              -- 可选：点横幅去哪
    active     INTEGER NOT NULL DEFAULT 1,
    starts_at  INTEGER,                           -- NULL = 立即
    ends_at    INTEGER,                           -- NULL = 不过期
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_banners_active ON banners(active, ends_at);

CREATE TABLE IF NOT EXISTS banner_dismissals (
    banner_id    INTEGER NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (banner_id, user_id)
);

-- 资源帖状态：持续更新 / 接受 bug 修复 / 停止维护
ALTER TABLE posts ADD COLUMN resource_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE posts ADD COLUMN resource_status_at INTEGER;

-- 收款码：一个用户可以挂多个渠道（渠道名自由填，不限死支付宝/微信）。
CREATE TABLE IF NOT EXISTS payment_channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel    TEXT    NOT NULL,                  -- alipay | wechat | 自定义
    label      TEXT    NOT NULL DEFAULT '',
    image_hash TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_channels_user ON payment_channels(user_id, id);
