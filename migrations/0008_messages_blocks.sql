-- ============================================================
-- 0008 私信 + 拉黑
--
-- messages：一对一私信。两侧各有 deleted 标记（各自删除不影响对方）。
-- blocks  ：单向拉黑（blocker 拉黑 blocked）；私信双向禁止，评论区屏蔽对方。
-- ============================================================

CREATE TABLE messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body              TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    read_at           INTEGER,
    sender_deleted    INTEGER NOT NULL DEFAULT 0,
    recipient_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_pair ON messages(sender_id, recipient_id, created_at DESC);
CREATE INDEX idx_messages_inbox ON messages(recipient_id, created_at DESC);

CREATE TABLE blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
);
