-- ============================================================
-- 0012 后端扩展：分区表 / 用户组 / 头衔 / 等级经验 / 帖子置顶精华
--
-- 原则：只做**加法**（CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN），
-- 不动既有列与既有数据，保证在生产上可安全执行。
-- ============================================================

-- ---------------------------------------------------------------- 分区
-- 原来分区是硬编码枚举；落成表之后管理员才能新建 / 归档 / 排序。
-- key 仍然沿用枚举值，保证老数据（posts.section）能对上。
CREATE TABLE IF NOT EXISTS sections (
    key            TEXT PRIMARY KEY,
    label          TEXT    NOT NULL,
    description    TEXT    NOT NULL DEFAULT '',
    position       INTEGER NOT NULL DEFAULT 0,
    archived_at    INTEGER,
    -- 发帖 / 回帖的最低等级（member < developer < admin < super）
    post_min_role  TEXT    NOT NULL DEFAULT 'member',
    reply_min_role TEXT    NOT NULL DEFAULT 'member',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

INSERT OR IGNORE INTO sections (key, label, description, position, archived_at, post_min_role, reply_min_role, created_at, updated_at) VALUES
    ('announcement',     '公告',          '站点通知（只有管理员能发）', 0, NULL, 'admin',  'member', strftime('%s','now'), strftime('%s','now')),
    ('vanilla_mod',      '原版战役 mod',   '对官方战役的修改',           1, NULL, 'member', 'member', strftime('%s','now'), strftime('%s','now')),
    ('custom_campaign',  '自制战役',       '整段新战役',                 2, NULL, 'member', 'member', strftime('%s','now'), strftime('%s','now')),
    ('tool_player',      '工具（玩家用）', '启动器、补丁合成、汉化之类', 3, NULL, 'developer', 'member', strftime('%s','now'), strftime('%s','now')),
    ('tool_dev',         '工具（开发者用）', '地图编辑、脚本、打包',     4, NULL, 'developer', 'member', strftime('%s','now'), strftime('%s','now'));

-- 分区管理员：**当前不给额外权限**（与普通用户一样），先把位置留出来，
-- 之后要做「本分区可删帖 / 可审核」时直接读这张表。
CREATE TABLE IF NOT EXISTS section_moderators (
    section    TEXT    NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (section, user_id)
);
CREATE INDEX IF NOT EXISTS idx_section_moderators_user ON section_moderators(user_id);

-- ---------------------------------------------------------------- 用户组
-- 组用来做「更精确的限制」：目前落地到「某组在某分区能不能发帖 / 回帖」。
CREATE TABLE IF NOT EXISTS user_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    archived_at INTEGER,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_group_members (
    group_id   INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON user_group_members(user_id);

-- 组 × 分区 的发言规则：给了行就是白名单，没给就是不受该组限制。
CREATE TABLE IF NOT EXISTS group_section_rules (
    group_id  INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    section   TEXT    NOT NULL,
    can_post  INTEGER NOT NULL DEFAULT 0,
    can_reply INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, section)
);

-- ---------------------------------------------------------------- 头衔
CREATE TABLE IF NOT EXISTS titles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    color       TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    archived_at INTEGER,
    created_at  INTEGER NOT NULL
);

-- 一个用户可以有多个头衔；佩戴其中一个（或都不戴）
CREATE TABLE IF NOT EXISTS user_titles (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    granted_at INTEGER NOT NULL,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, title_id)
);
CREATE INDEX IF NOT EXISTS idx_user_titles_user ON user_titles(user_id);

-- ---------------------------------------------------------------- 等级 / 经验
-- 当前只「注册」：列 + 事件表都在，增长规则与前端之后再接。
ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN exp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN equipped_title_id INTEGER REFERENCES titles(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS exp_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta      INTEGER NOT NULL,
    reason     TEXT    NOT NULL,
    ref        TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exp_events_user ON exp_events(user_id, created_at DESC);

-- ---------------------------------------------------------------- 帖子：置顶 / 精华 / 推送
-- pinned_rank 越大越靠前（0 = 未置顶）；同 rank 按时间倒序。
ALTER TABLE posts ADD COLUMN pinned_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN pinned_at INTEGER;
ALTER TABLE posts ADD COLUMN pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN featured_at INTEGER;
ALTER TABLE posts ADD COLUMN featured_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN pushed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_posts_pinned ON posts(pinned_rank DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_featured ON posts(featured_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_title ON posts(title);
CREATE INDEX IF NOT EXISTS idx_posts_section_created ON posts(section, created_at DESC);
