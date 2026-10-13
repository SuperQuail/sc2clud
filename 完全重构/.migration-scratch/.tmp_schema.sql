==== index idx_ai_reviews_target
CREATE INDEX idx_ai_reviews_target ON ai_reviews(target_kind, target_id, created_at DESC)
==== index idx_audit_created
CREATE INDEX idx_audit_created ON audit_log(created_at DESC)
==== index idx_banners_active
CREATE INDEX idx_banners_active ON banners(active, ends_at)
==== index idx_comment_votes_comment
CREATE INDEX idx_comment_votes_comment ON comment_votes(comment_id)
==== index idx_comments_parent
CREATE INDEX idx_comments_parent ON comments(parent_id)
==== index idx_comments_post
CREATE INDEX idx_comments_post ON comments(post_id, created_at)
==== index idx_donation_donor
CREATE INDEX idx_donation_donor
    ON donation_records(donor_id, state, paid_at DESC)
==== index idx_donation_post
CREATE INDEX idx_donation_post
    ON donation_records(post_id, state, paid_at DESC)
==== index idx_donation_queue
CREATE INDEX idx_donation_queue
    ON donation_records(state, created_at)
==== index idx_donation_recipient
CREATE INDEX idx_donation_recipient
    ON donation_records(recipient_id, state, paid_at DESC)
==== index idx_email_codes_created
CREATE INDEX idx_email_codes_created ON email_codes(created_at)
==== index idx_email_codes_email
CREATE INDEX idx_email_codes_email   ON email_codes(email, created_at DESC)
==== index idx_exp_events_user
CREATE INDEX idx_exp_events_user ON exp_events(user_id, created_at DESC)
==== index idx_files_blob
CREATE INDEX idx_files_blob  ON files(blob_hash)
==== index idx_files_owner
CREATE INDEX idx_files_owner ON files(owner_id, created_at DESC)
==== index idx_group_members_user
CREATE INDEX idx_group_members_user ON user_group_members(user_id)
==== index idx_image_jobs_state
CREATE INDEX idx_image_jobs_state ON image_jobs(state, id)
==== index idx_issue_comment_votes_comment
CREATE INDEX idx_issue_comment_votes_comment ON issue_comment_votes(comment_id)
==== index idx_issue_comments_issue
CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id, id)
==== index idx_mail_accounts_pick
CREATE INDEX idx_mail_accounts_pick
    ON mail_accounts(archived_at, enabled, priority, id)
==== index idx_messages_inbox
CREATE INDEX idx_messages_inbox ON messages(recipient_id, created_at DESC)
==== index idx_messages_pair
CREATE INDEX idx_messages_pair ON messages(sender_id, recipient_id, created_at DESC)
==== index idx_notifications_unread
CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at, created_at DESC)
==== index idx_notifications_user_kind_link
CREATE INDEX idx_notifications_user_kind_link ON notifications(user_id, kind, link)
==== index idx_payment_channels_user
CREATE INDEX idx_payment_channels_user ON payment_channels(user_id, id)
==== index idx_post_images_post
CREATE INDEX idx_post_images_post ON post_images(post_id, position)
==== index idx_post_issues_post
CREATE INDEX idx_post_issues_post ON post_issues(post_id, state, id DESC)
==== index idx_post_revisions_at
CREATE INDEX idx_post_revisions_at ON post_revisions(submitted_at)
==== index idx_post_sources_post
CREATE INDEX idx_post_sources_post ON post_sources(post_id, position)
==== index idx_posts_archived
CREATE INDEX idx_posts_archived ON posts(archived_at, created_at DESC)
==== index idx_posts_created
CREATE INDEX idx_posts_created ON posts(created_at DESC)
==== index idx_posts_featured
CREATE INDEX idx_posts_featured ON posts(featured_at DESC)
==== index idx_posts_feed
CREATE INDEX idx_posts_feed ON posts(review_state, created_at DESC)
==== index idx_posts_pinned
CREATE INDEX idx_posts_pinned ON posts(pinned_rank DESC, created_at DESC)
==== index idx_posts_section
CREATE INDEX idx_posts_section ON posts(section, review_state, created_at DESC)
==== index idx_posts_section_created
CREATE INDEX idx_posts_section_created ON posts(section, created_at DESC)
==== index idx_posts_title
CREATE INDEX idx_posts_title ON posts(title)
==== index idx_release_assets_release
CREATE INDEX idx_release_assets_release ON release_assets(release_id)
==== index idx_releases_version_channel
CREATE UNIQUE INDEX idx_releases_version_channel ON releases(version, channel)
==== index idx_reports_target
CREATE INDEX idx_reports_target ON reports(target_kind, target_id, state)
==== index idx_section_moderators_user
CREATE INDEX idx_section_moderators_user ON section_moderators(user_id)
==== index idx_sessions_expires
CREATE INDEX idx_sessions_expires ON sessions(expires_at)
==== index idx_sessions_user
CREATE INDEX idx_sessions_user    ON sessions(user_id)
==== index idx_upload_sessions_owner
CREATE INDEX idx_upload_sessions_owner ON upload_sessions(owner_id, expires_at)
==== index idx_user_sanctions_user
CREATE INDEX idx_user_sanctions_user ON user_sanctions(user_id, revoked_at, until)
==== index idx_user_titles_user
CREATE INDEX idx_user_titles_user ON user_titles(user_id)
==== index idx_users_avatar
CREATE INDEX idx_users_avatar ON users(avatar_hash)
==== index sqlite_autoindex__sqlx_migrations_1
None
==== index sqlite_autoindex_banner_dismissals_1
None
==== index sqlite_autoindex_banner_groups_1
None
==== index sqlite_autoindex_blobs_1
None
==== index sqlite_autoindex_blocks_1
None
==== index sqlite_autoindex_comment_votes_1
None
==== index sqlite_autoindex_counters_1
None
==== index sqlite_autoindex_donation_notice_defaults_1
None
==== index sqlite_autoindex_group_section_rules_1
None
==== index sqlite_autoindex_issue_comment_votes_1
None
==== index sqlite_autoindex_notification_mutes_1
None
==== index sqlite_autoindex_post_bookmarks_1
None
==== index sqlite_autoindex_post_likes_1
None
==== index sqlite_autoindex_section_covers_1
None
==== index sqlite_autoindex_section_moderators_1
None
==== index sqlite_autoindex_sections_1
None
==== index sqlite_autoindex_sessions_1
None
==== index sqlite_autoindex_settings_1
None
==== index sqlite_autoindex_site_default_avatars_1
None
==== index sqlite_autoindex_site_domains_1
None
==== index sqlite_autoindex_site_texts_1
None
==== index sqlite_autoindex_titles_1
None
==== index sqlite_autoindex_upload_sessions_1
None
==== index sqlite_autoindex_user_group_members_1
None
==== index sqlite_autoindex_user_groups_1
None
==== index sqlite_autoindex_user_titles_1
None
==== index sqlite_autoindex_users_1
None
==== index sqlite_autoindex_users_2
None
==== table _sqlx_migrations
CREATE TABLE _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
)
==== table ai_reviews
CREATE TABLE ai_reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    target_kind   TEXT    NOT NULL,
    target_id     INTEGER NOT NULL,
    source        TEXT    NOT NULL,        -- new_post | report | manual
    verdict       TEXT    NOT NULL,        -- approve | pending | reject
    reason        TEXT    NOT NULL DEFAULT '',
    raw_response  TEXT    NOT NULL DEFAULT '',
    model         TEXT    NOT NULL DEFAULT '',
    ok            INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
)
==== table ai_secrets
CREATE TABLE ai_secrets (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    key_cipher   BLOB    NOT NULL,
    key_nonce    BLOB    NOT NULL,
    updated_at   INTEGER NOT NULL,
    updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
)
==== table announcements
CREATE TABLE announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
)
==== table audit_log
CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   INTEGER,
    action     TEXT    NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL
)
==== table banner_dismissals
CREATE TABLE banner_dismissals (
    banner_id    INTEGER NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (banner_id, user_id)
)
==== table banner_groups
CREATE TABLE banner_groups (
    banner_id INTEGER NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
    group_id  INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (banner_id, group_id)
)
==== table banners
CREATE TABLE banners (
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
)
==== table blobs
CREATE TABLE blobs (
    hash       TEXT    PRIMARY KEY,
    size       INTEGER NOT NULL,
    refcount   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
, owner_id INTEGER REFERENCES users(id), visibility INTEGER NOT NULL DEFAULT 0)
==== table blocks
CREATE TABLE blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
)
==== table comment_votes
CREATE TABLE comment_votes (
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value      INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (comment_id, user_id)
)
==== table comments
CREATE TABLE comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
, parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE)
==== table counters
CREATE TABLE counters (
    key   TEXT    PRIMARY KEY,
    value INTEGER NOT NULL
)
==== table donation_notice_defaults
CREATE TABLE donation_notice_defaults (
    channel    TEXT PRIMARY KEY,
    text       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
)
==== table donation_records
CREATE TABLE donation_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 打赏人（提交者）
    donor_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 被打赏人（收款的作者）
    recipient_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 金额一律用**整数分**，绝不用浮点
    amount_cents   INTEGER NOT NULL,
    -- 订单号：可选，给人核对的凭据（各家规则不同，只限长度）
    txn_id         TEXT    NOT NULL DEFAULT '',
    -- 打赏发生时间（Unix 秒）
    paid_at        INTEGER NOT NULL,
    -- 这条打赏是在**哪篇帖子**下发生的。
    -- 帖子页打赏会带上；作者主页打赏没有帖子上下文，为 NULL。
    -- 帖子删除时置 NULL（记录本身要留着，钱是发生过的）。
    post_id        INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    -- pending 待验证 | approved 已验证 | rejected 未通过
    state          TEXT    NOT NULL DEFAULT 'pending',
    -- 管理员审核意见
    review_note    TEXT,
    reviewed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at    INTEGER,
    -- 结算：NULL = 尚未结算；仅对 approved 有意义
    settled_at     INTEGER,
    settlement_ref TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    deleted_at     INTEGER,

    -- 金额必须为正：0 与负数都是脏数据
    CHECK (amount_cents > 0),
    -- 不能给自己打赏
    CHECK (donor_id <> recipient_id),
    CHECK (state IN ('pending', 'approved', 'rejected'))
)
==== table email_codes
CREATE TABLE "email_codes" (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    NOT NULL,
    code_hash   TEXT    NOT NULL,
    salt        TEXT    NOT NULL,
    purpose     TEXT    NOT NULL DEFAULT 'register',
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER,
    attempts    INTEGER NOT NULL DEFAULT 0,
    account_id  INTEGER REFERENCES mail_accounts(id) ON DELETE SET NULL,
    request_ip  TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
)
==== table exp_events
CREATE TABLE exp_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta      INTEGER NOT NULL,
    reason     TEXT    NOT NULL,
    ref        TEXT,
    created_at INTEGER NOT NULL
)
==== table files
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
)
==== table group_section_rules
CREATE TABLE group_section_rules (
    group_id  INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    section   TEXT    NOT NULL,
    can_post  INTEGER NOT NULL DEFAULT 0,
    can_reply INTEGER NOT NULL DEFAULT 0, deny_post  INTEGER NOT NULL DEFAULT 0, deny_reply INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, section)
)
==== table image_jobs
CREATE TABLE image_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id      INTEGER NOT NULL REFERENCES post_images(id) ON DELETE CASCADE,
    original_hash TEXT    NOT NULL,
    state         TEXT    NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
)
==== table issue_comment_votes
CREATE TABLE issue_comment_votes (
  comment_id INTEGER NOT NULL REFERENCES issue_comments(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  value      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
)
==== table issue_comments
CREATE TABLE issue_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id   INTEGER NOT NULL REFERENCES post_issues(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
, parent_id INTEGER REFERENCES issue_comments(id))
==== table mail_accounts
CREATE TABLE mail_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 'resend' / 'smtp' / ...（不加 CHECK：加 provider 不该改表，合法性在代码里校验）
    provider       TEXT    NOT NULL,
    label          TEXT    NOT NULL DEFAULT '',
    -- 小的先用；同 priority 按 id。故障转移与额度轮换都走这个顺序。
    priority       INTEGER NOT NULL DEFAULT 100,

    -- ---- 发信人身份（所有 provider 共用）----
    from_address   TEXT    NOT NULL,
    from_name      TEXT    NOT NULL DEFAULT '',
    reply_to       TEXT    NOT NULL DEFAULT '',

    -- ---- 凭据：整份加密的 JSON，形状由 provider 决定 ----
    -- smtp   → {"password":"..."}
    -- resend → {"api_key":"re_..."}
    -- NULL 表示还没配：账号可以存在、可以在后台看到，但不可用。
    secret_cipher  BLOB,
    secret_nonce   BLOB,
    -- ---- provider 专属的非敏感参数（明文 JSON）；db 层不当 JSON 解析，原样返回 ----
    -- smtp   → {"host":"smtp.qq.com","port":465,"tls":"implicit","username":"..."}
    -- resend → {"base_url":"https://api.resend.com"}
    options_json   TEXT    NOT NULL DEFAULT '{}',

    -- ---- 额度账 ----
    daily_quota    INTEGER NOT NULL DEFAULT 0,   -- 0 = 不限
    sent_today     INTEGER NOT NULL DEFAULT 0,
    quota_day      INTEGER NOT NULL DEFAULT 0,   -- UTC 日起点 unix；与今天不等即视为新的一天

    -- ---- 可用性 / 熔断 ----
    enabled        INTEGER NOT NULL DEFAULT 1,   -- 运维手动停用
    cooldown_until INTEGER,                      -- 限速或故障后的冷却截止（unix 秒）
    last_ok_at     INTEGER,
    last_error     TEXT    NOT NULL DEFAULT '',
    last_error_at  INTEGER,

    archived_at    INTEGER,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
)
==== table messages
CREATE TABLE messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body              TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    read_at           INTEGER,
    sender_deleted    INTEGER NOT NULL DEFAULT 0,
    recipient_deleted INTEGER NOT NULL DEFAULT 0
)
==== table notification_mutes
CREATE TABLE notification_mutes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    link       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, link)
)
==== table notifications
CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    payload    TEXT    NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    read_at    INTEGER
, title TEXT NOT NULL DEFAULT '', body TEXT, link TEXT, actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, deleted_at INTEGER)
==== table payment_channels
CREATE TABLE payment_channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel    TEXT    NOT NULL,                  -- alipay | wechat | 自定义
    label      TEXT    NOT NULL DEFAULT '',
    image_hash TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
)
==== table post_bookmarks
CREATE TABLE post_bookmarks (
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
)
==== table post_images
CREATE TABLE post_images (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL DEFAULT 0,
    original_hash  TEXT    NOT NULL,          -- 原图（内容寻址，永久保留）
    display_hash   TEXT,                      -- 压缩后展示图（异步生成前为 NULL）
    thumb_hash     TEXT,                      -- 缩略图
    width          INTEGER,
    height         INTEGER,
    original_bytes INTEGER NOT NULL,
    display_bytes  INTEGER,
    mime           TEXT    NOT NULL DEFAULT 'image/webp',
    state          TEXT    NOT NULL DEFAULT 'processing', -- processing | ready | failed
    created_at     INTEGER NOT NULL
)
==== table post_issues
CREATE TABLE post_issues (
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
)
==== table post_likes
CREATE TABLE post_likes (
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
)
==== table post_revisions
CREATE TABLE post_revisions (
    post_id      INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    title        TEXT    NOT NULL,
    body         TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    section      TEXT    NOT NULL,
    submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    submitted_at INTEGER NOT NULL,
    note         TEXT
)
==== table post_sources
CREATE TABLE post_sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL DEFAULT 0,
    provider     TEXT    NOT NULL,              -- baidu | quark | aliyun | lanzou | 123pan | weiyun | github | direct
    label        TEXT,                          -- 可选的显示名，如「完整包」「补丁」
    url          TEXT    NOT NULL,
    extract_code TEXT,                          -- 网盘提取码
    created_at   INTEGER NOT NULL
)
==== table posts
CREATE TABLE posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
, kind TEXT NOT NULL DEFAULT 'discussion', review_state TEXT NOT NULL DEFAULT 'approved', review_note TEXT, reviewed_at INTEGER, reviewed_by INTEGER, auto_reviewed INTEGER NOT NULL DEFAULT 0, image_count INTEGER NOT NULL DEFAULT 0, section TEXT NOT NULL DEFAULT 'custom_campaign', archived_at INTEGER, pinned_rank INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER, pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL, featured_at INTEGER, featured_by INTEGER REFERENCES users(id) ON DELETE SET NULL, pushed_at INTEGER, resource_status TEXT NOT NULL DEFAULT 'active', resource_status_at INTEGER)
==== table release_assets
CREATE TABLE release_assets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id     INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    platform       TEXT    NOT NULL,                 -- windows | macos | linux
    arch           TEXT    NOT NULL DEFAULT 'x86_64',
    filename       TEXT    NOT NULL,
    url            TEXT    NOT NULL,                 -- 外部直链：本站只索引与转链
    size           INTEGER NOT NULL DEFAULT 0,
    sha256         TEXT,                             -- 校验值（可选，帮助用户核对）
    download_count INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
)
==== table releases
CREATE TABLE releases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    version      TEXT    NOT NULL,
    channel      TEXT    NOT NULL DEFAULT 'stable',   -- stable | beta
    title        TEXT,
    notes        TEXT,
    is_published INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER,
    created_at   INTEGER NOT NULL,
    published_at INTEGER
)
==== table reports
CREATE TABLE reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_kind TEXT    NOT NULL,          -- post | comment
    target_id   INTEGER NOT NULL,
    reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason      TEXT    NOT NULL DEFAULT '',
    state       TEXT    NOT NULL DEFAULT 'open',  -- open | ai_reviewed | handled | dismissed
    created_at  INTEGER NOT NULL,
    handled_at  INTEGER,
    handled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
)
==== table section_covers
CREATE TABLE section_covers (
    section    TEXT PRIMARY KEY,
    cover_hash TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
)
==== table section_moderators
CREATE TABLE section_moderators (
    section    TEXT    NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (section, user_id)
)
==== table sections
CREATE TABLE sections (
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
, group_check INTEGER NOT NULL DEFAULT 0)
==== table sessions
CREATE TABLE sessions (
    id           TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token   TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT
)
==== table settings
CREATE TABLE settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER
)
==== table site_default_avatars
CREATE TABLE site_default_avatars (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hash       TEXT    NOT NULL UNIQUE,
    mime       TEXT    NOT NULL DEFAULT 'image/webp',
    note       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
)
==== table site_domains
CREATE TABLE site_domains (
    domain     TEXT PRIMARY KEY,   -- 规范化后：小写、去端口、去开头 www.
    note       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
)
==== table site_texts
CREATE TABLE site_texts (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
)
==== table smtp_accounts_0031_legacy
CREATE TABLE "smtp_accounts_0031_legacy" (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    label         TEXT    NOT NULL DEFAULT '',
    host          TEXT    NOT NULL,
    port          INTEGER NOT NULL DEFAULT 465,
    username      TEXT    NOT NULL DEFAULT '',
    pass_cipher   BLOB,
    pass_nonce    BLOB,
    from_address  TEXT    NOT NULL,
    from_name     TEXT    NOT NULL DEFAULT 'SC2clud',
    tls           TEXT    NOT NULL DEFAULT 'implicit',
    priority      INTEGER NOT NULL DEFAULT 100,
    archived_at   INTEGER,
    last_ok_at    INTEGER,
    last_error    TEXT    NOT NULL DEFAULT '',
    last_error_at INTEGER,
    created_at    INTEGER NOT NULL
)
==== table sqlite_sequence
CREATE TABLE sqlite_sequence(name,seq)
==== table titles
CREATE TABLE titles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    color       TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    archived_at INTEGER,
    created_at  INTEGER NOT NULL
)
==== table upload_sessions
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
)
==== table user_group_members
CREATE TABLE user_group_members (
    group_id   INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
)
==== table user_groups
CREATE TABLE user_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    archived_at INTEGER,
    created_at  INTEGER NOT NULL
)
==== table user_sanctions
CREATE TABLE user_sanctions (
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
)
==== table user_titles
CREATE TABLE user_titles (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title_id   INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    granted_at INTEGER NOT NULL,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, title_id)
)
==== table users
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
, activated_at INTEGER, activated_by INTEGER, display_name TEXT NOT NULL DEFAULT '', avatar_hash TEXT, avatar_mime TEXT, trusted INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1, exp INTEGER NOT NULL DEFAULT 0, equipped_title_id INTEGER REFERENCES titles(id) ON DELETE SET NULL, donation_visible INTEGER NOT NULL DEFAULT 0, donation_notice_visible INTEGER NOT NULL DEFAULT 1, donation_notice_text    TEXT    NOT NULL DEFAULT '', bio               TEXT NOT NULL DEFAULT '', bio_review_state  TEXT NOT NULL DEFAULT 'approved', bio_review_note   TEXT, bio_updated_at    INTEGER, default_avatar_hash TEXT, avatar_small TEXT, post_ban_until INTEGER, donation_records_public INTEGER NOT NULL DEFAULT 0)