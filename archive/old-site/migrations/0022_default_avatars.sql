-- ============================================================
-- 0022 默认头像池 + 通知删除/不再通知
-- 纯加法。
-- ============================================================

-- 管理员维护的默认头像池；用户没有头像时按池随机分一个（结果存在 users.default_avatar_hash）。
CREATE TABLE IF NOT EXISTS site_default_avatars (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hash       TEXT    NOT NULL UNIQUE,
    mime       TEXT    NOT NULL DEFAULT 'image/webp',
    note       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- 用户分到的默认头像（随机分配后固定，不会每次刷新都变）。
ALTER TABLE users ADD COLUMN default_avatar_hash TEXT;

-- 通知软删除：用户点「删除该通知」只对自己隐藏。
ALTER TABLE notifications ADD COLUMN deleted_at INTEGER;

-- 「不再通知」：对某个内容（link）或某个类别静音。
CREATE TABLE IF NOT EXISTS notification_mutes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    link       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, link)
);
