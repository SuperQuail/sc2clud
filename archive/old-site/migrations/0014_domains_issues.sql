-- ============================================================
-- 0014 后端扩展：站点域名 / 资源帖 issue / 横幅定向用户组
-- 纯加法，可在生产安全执行。
-- ============================================================

-- 统一域名管理：哪些域名算「我们自己」（链接解析、以后发信/回跳都用它）。
-- 不必手工填：应用启动时会把自己 base_url 的域名自动登记进来。
CREATE TABLE IF NOT EXISTS site_domains (
    domain     TEXT PRIMARY KEY,   -- 规范化后：小写、去端口、去开头 www.
    note       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

-- 资源帖 issue（bug / 功能建议）：用户提，作者与管理员可关。
CREATE TABLE IF NOT EXISTS post_issues (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL DEFAULT 'bug',    -- bug | feature | other
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    state      TEXT    NOT NULL DEFAULT 'open',   -- open | closed
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at  INTEGER,
    closed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_post_issues_post ON post_issues(post_id, state, id DESC);

CREATE TABLE IF NOT EXISTS issue_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id   INTEGER NOT NULL REFERENCES post_issues(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id, id);

-- 横幅定向：给了行就只对这些用户组可见（没有行 = 所有人）。
CREATE TABLE IF NOT EXISTS banner_groups (
    banner_id INTEGER NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
    group_id  INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (banner_id, group_id)
);
