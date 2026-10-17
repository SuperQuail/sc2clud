-- ============================================================
-- 0031 SMTP 验证码：多个发信账号（主 + 备选，按优先级故障转移）+ 验证码 + 限流配置
-- 密码复用 ChaCha20-Poly1305 那套加密，单独列存密文与 nonce。
-- ============================================================

CREATE TABLE IF NOT EXISTS smtp_accounts (
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
);

CREATE TABLE IF NOT EXISTS email_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    NOT NULL,
    code_hash   TEXT    NOT NULL,
    salt        TEXT    NOT NULL,
    purpose     TEXT    NOT NULL DEFAULT 'register',
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER,
    attempts    INTEGER NOT NULL DEFAULT 0,
    account_id  INTEGER REFERENCES smtp_accounts(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, created_at DESC);

INSERT OR IGNORE INTO site_texts (key, value, updated_at) VALUES
    ('mail_enabled', '0', strftime('%s','now')),
    ('mail_per_minute', '5', strftime('%s','now')),
    ('mail_cooldown_seconds', '60', strftime('%s','now')),
    ('mail_code_ttl_seconds', '600', strftime('%s','now'));
