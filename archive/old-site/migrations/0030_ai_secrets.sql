-- ============================================================
-- 0030 AI 的 API 密钥单独存表并加密（ChaCha20-Poly1305，密钥来自环境变量或 data/secret.key）
-- 其它配置（endpoint / model / 提示词 / 开关）继续放 site_texts。
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_secrets (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    key_cipher   BLOB    NOT NULL,
    key_nonce    BLOB    NOT NULL,
    updated_at   INTEGER NOT NULL,
    updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- 明文那一行立刻删掉（迁移前没设置过就什么都不做）
DELETE FROM site_texts WHERE key = 'ai_api_key';
