-- ============================================================
-- 0016 待审修改：编辑帖子后先不动原帖，等审核通过再替换
-- 纯加法。
-- ============================================================

-- 一帖最多一份待审修改（PRIMARY KEY(post_id)），第二次编辑覆盖第一份。
-- 通过前：posts 仍是**原内容**，对外一切照旧；发布者侧看到「修改内容审核中」。
CREATE TABLE IF NOT EXISTS post_revisions (
    post_id      INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    title        TEXT    NOT NULL,
    body         TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    section      TEXT    NOT NULL,
    submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    submitted_at INTEGER NOT NULL,
    note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_post_revisions_at ON post_revisions(submitted_at);
