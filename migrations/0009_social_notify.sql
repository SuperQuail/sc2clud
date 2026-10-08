-- ============================================================
-- 0009 点赞 / 收藏 / 通知 / 系统公告
--
-- post_likes / post_bookmarks：一对一的开关关系，主键天然去重。
-- notifications：站内提醒（私信、点赞、审核结果、系统公告）。
-- announcements：**独立于帖子**的系统公告，只有管理员能发。
-- ============================================================

CREATE TABLE post_likes (
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE post_bookmarks (
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
);

-- 注意：`notifications` 在 0001 里就建过（当时留的占位表），这里只**加列**。
-- 重复建表会让整个迁移失败，连带 12 个数据库测试全红（踩过一次）。
ALTER TABLE notifications ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN body TEXT;
ALTER TABLE notifications ADD COLUMN link TEXT;

CREATE TABLE announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
);
