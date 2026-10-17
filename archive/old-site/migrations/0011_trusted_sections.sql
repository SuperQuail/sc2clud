-- ============================================================
-- 0011 信任账号 + 分区封面
--
-- users.trusted：被信任的账号发帖**只走自动审核**（审核机说行就行，不进人工队列）。
--   —— 自动审核目前内容很少，这个开关先把机制搭出来，便于之后加规则。
-- section_covers：分区封面图（内容寻址），管理员及以上可设置。
-- ============================================================

ALTER TABLE users ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE section_covers (
    section    TEXT PRIMARY KEY,
    cover_hash TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
);
