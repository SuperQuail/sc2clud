-- ============================================================
-- 0036 发信账号：provider 中立的多账号表（取代 0031 的 smtp_accounts）
--
-- 一行 = 一个「发信身份」：provider + 凭据 + 发件人 + 额度账 + 健康。
--
-- 为什么不用 0031 那种形状：
--   · 0031 的 host/port/tls 都是 NOT NULL，而 Resend 没有这些概念，只能塞假值；
--   · 0031 的密码是定长一列，但不同 provider 的凭据字段数量不同
--     （smtp: password；resend: api_key；ses: access_key + secret_key + region）。
--   改法：所有 provider 都有的做成显式列（可排序、可索引、后台直接展示），
--         只有某个 provider 才有的塞进两份 blob：
--           secret_cipher/nonce —— 整份凭据加密成 JSON，形状由 provider 决定
--           options_json        —— provider 专属的**非敏感**参数，明文，便于后台展示
--         于是加第三个 provider 不用再动表。
--
-- 额度账（daily_quota / sent_today / quota_day）是多 key 轮换的依据：
--   Resend 每个 key 的免费额度互相独立，前一个号当日用完 → 自动落到下一个 priority。
-- ============================================================

CREATE TABLE IF NOT EXISTS mail_accounts (
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
);

-- 选号查询走这条：WHERE archived_at IS NULL AND enabled = 1 ORDER BY priority, id
CREATE INDEX IF NOT EXISTS idx_mail_accounts_pick
    ON mail_accounts(archived_at, enabled, priority, id);

-- 0031 里若真的有人手工录过账号，把加密凭据一起搬过来（host/port/tls 留在旧表人工补录）。
-- 注意：没有任何代码路径能写入 smtp_accounts，任何部署上这里都是 0 行。
INSERT INTO mail_accounts
    (provider, label, from_address, from_name, priority,
     secret_cipher, secret_nonce, created_at, updated_at)
SELECT 'smtp', label, from_address, from_name, priority,
       pass_cipher, pass_nonce, created_at, created_at
FROM smtp_accounts;

-- email_codes 必须重建：0031 里 account_id 的外键指向 smtp_accounts，
-- 而写验证码时要填的是 mail_accounts 的 id —— 外键校验会直接让 INSERT 失败。
-- 顺带补两处：created_at 索引（全局日限额要按它扫）、来源 IP（防刷码取证）。
CREATE TABLE email_codes_new (
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
);
INSERT INTO email_codes_new
    (id, email, code_hash, salt, purpose, expires_at, consumed_at, attempts, created_at)
SELECT id, email, code_hash, salt, purpose, expires_at, consumed_at, attempts, created_at
FROM email_codes;
DROP TABLE email_codes;
ALTER TABLE email_codes_new RENAME TO email_codes;
CREATE INDEX IF NOT EXISTS idx_email_codes_email   ON email_codes(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_codes_created ON email_codes(created_at);

-- 旧表改名留档，不 DROP：里面可能有人手工 sqlite3 录过的凭据。
ALTER TABLE smtp_accounts RENAME TO smtp_accounts_0031_legacy;
