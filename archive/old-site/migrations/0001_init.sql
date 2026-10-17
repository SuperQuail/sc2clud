-- ============================================================
-- SC2clud 初始 schema（SQLite / WAL）
-- 约定：
--   * 时间一律用 Unix 秒（INTEGER），不引入日期库；
--   * 内容寻址：blobs 一行 = 盘上一份内容，files 一行 = 一个用户可见文件名，
--     多行 files 指向同一 blob 即为去重与秒传；
--   * 计数走 counters 表批量落库（写热点禁止每请求 UPDATE）。
-- ============================================================

-- ---------- 用户与会话 ----------
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    handle        TEXT    NOT NULL UNIQUE,
    email         TEXT    UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'member',
    quota_bytes   INTEGER NOT NULL DEFAULT 1073741824,
    used_bytes    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    disabled_at   INTEGER
);

CREATE TABLE sessions (
    id           TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token   TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ---------- 社区内容 ----------
CREATE TABLE posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX idx_posts_created ON posts(created_at DESC);

CREATE TABLE comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX idx_comments_post ON comments(post_id, created_at);

CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    payload    TEXT    NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    read_at    INTEGER
);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at, created_at DESC);

-- ---------- 文件与内容寻址存储 ----------
CREATE TABLE blobs (
    hash       TEXT    PRIMARY KEY,
    size       INTEGER NOT NULL,
    refcount   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE files (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blob_hash      TEXT    NOT NULL REFERENCES blobs(hash),
    name           TEXT    NOT NULL,
    mime           TEXT    NOT NULL DEFAULT 'application/octet-stream',
    size           INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    deleted_at     INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_files_owner ON files(owner_id, created_at DESC);
CREATE INDEX idx_files_blob  ON files(blob_hash);

-- 分片上传会话（断点续传；下载侧由 nginx 原生 Range 承担，无需状态）
CREATE TABLE upload_sessions (
    id              TEXT    PRIMARY KEY,
    owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    expected_hash   TEXT,
    declared_size   INTEGER NOT NULL,
    received_bytes  INTEGER NOT NULL DEFAULT 0,
    chunk_size      INTEGER NOT NULL DEFAULT 4194304,
    received_chunks TEXT    NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
);
CREATE INDEX idx_upload_sessions_owner ON upload_sessions(owner_id, expires_at);

-- ---------- 写回缓冲落点 ----------
CREATE TABLE counters (
    key   TEXT    PRIMARY KEY,
    value INTEGER NOT NULL
);
