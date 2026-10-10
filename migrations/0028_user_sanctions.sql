-- ============================================================
-- 0028 处罚表：支持「禁止发帖 / 禁止评论」× 「全局 / 指定分区」× 到期时间
-- 老的 users.post_ban_until（全局禁止发帖）迁进来，不丢数据。
-- ============================================================

CREATE TABLE IF NOT EXISTS user_sanctions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- post = 禁止发帖；reply = 禁止评论
    kind       TEXT    NOT NULL,
    -- 空串 = 全局；否则是分区 key
    section    TEXT    NOT NULL DEFAULT '',
    until      INTEGER NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_user_sanctions_user ON user_sanctions(user_id, revoked_at, until);

-- 老数据搬进来（全局禁止发帖）
INSERT INTO user_sanctions (user_id, kind, section, until, note, created_at)
SELECT id, 'post', '', post_ban_until, '由旧的 post_ban_until 迁移', strftime('%s','now')
FROM users WHERE post_ban_until IS NOT NULL;
