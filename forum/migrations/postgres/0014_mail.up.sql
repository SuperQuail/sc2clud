-- 0014_mail.up.sql —— 邮件：发信账号 / 每日额度账 / 每封一条日志
-- 依据：d1-platform §8.1；d6-reward §3.2 的 DDL（真源）；数据库文档 §2 全局约定、§4.8。

-- ============================================================
-- 1) mail_accounts：发信账号（凭据加密，主密钥在环境变量）
-- ============================================================
CREATE TABLE mail_accounts (
  id                bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         uuid         NOT NULL UNIQUE,
  name              varchar(64)  NOT NULL UNIQUE,
  provider          text         NOT NULL,
  priority          int          NOT NULL DEFAULT 0,
  daily_limit       int          NOT NULL DEFAULT 100,
  reset_tz          varchar(64)  NOT NULL DEFAULT 'Asia/Shanghai',
  from_address      varchar(254) NOT NULL,
  from_name         varchar(64)  NOT NULL DEFAULT '',
  options_json      jsonb        NOT NULL DEFAULT '{}',
  secret_cipher     bytea        NULL,
  secret_nonce      bytea        NULL,
  secret_updated_at timestamptz  NULL,
  enabled           boolean      NOT NULL DEFAULT true,
  archived_at       timestamptz  NULL,     -- 归档不硬删（额度账还挂着它的外键）
  last_ok_at        timestamptz  NULL,
  last_error        text         NULL,
  last_error_at     timestamptz  NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_mail_accounts_provider CHECK (provider IN ('resend','smtp')),
  CONSTRAINT ck_mail_accounts_priority CHECK (priority >= 0),
  CONSTRAINT ck_mail_accounts_limit    CHECK (daily_limit > 0),
  -- 密文与 nonce 必须成对：只有一个是解不开的半截凭据
  CONSTRAINT ck_mail_accounts_secret_pair
    CHECK ((secret_cipher IS NULL) = (secret_nonce IS NULL))
);
-- reset_tz 是 IANA 名字：合法性由 PG 自己知道（迁移期自检，不是表约束）：
--   SELECT a.name, a.reset_tz FROM mail_accounts a
--    WHERE NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = a.reset_tz);
--   有结果即失败（Go 侧 time.LoadLocation 也会失败，两处都会红）。

-- ============================================================
-- 2) mail_quota：每日额度账（必须持久化，禁止放内存）
-- ============================================================
CREATE TABLE mail_quota (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  account_id bigint      NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  day        date        NOT NULL,        -- PG 原生 date，不是字符串
  count      int         NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, day),   -- 原自然键：降为唯一
  CONSTRAINT ck_mail_quota_count CHECK (count >= 0)
);
-- account_id 是主键首列 → 级联删除路径已覆盖，不再补单列索引（拍板 §5.9 第 7 条：别建重复索引）。
-- 每次投递都在这一行上 +1（d6 §2.5）：持续更新的小表，收紧 autovacuum（盲审-运行 73）。
ALTER TABLE mail_quota SET (autovacuum_vacuum_scale_factor = 0.02,
                            autovacuum_vacuum_threshold    = 1000);

-- ============================================================
-- 3) mail_logs：每封邮件一条（幂等键是任务重试的支点）
-- ============================================================
CREATE TABLE mail_logs (
  id                  bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key     varchar(128) NOT NULL,
  to_address          varchar(254) NOT NULL,   -- to 是 SQL 关键字，列名避开
  template            varchar(64)  NOT NULL,
  payload             jsonb        NOT NULL DEFAULT '{}',
  status              text         NOT NULL DEFAULT 'pending',
  provider            varchar(32)  NOT NULL DEFAULT '',
  provider_message_id text         NULL,
  error               text         NULL,
  attempts            int          NOT NULL DEFAULT 0,
  quota_account_id    bigint       NULL REFERENCES mail_accounts(id) ON DELETE SET NULL,
  quota_day           date         NULL,       -- 这一次投递占的是哪天的额度（重试不重复占）
  sent_at             timestamptz  NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_mail_logs_status   CHECK (status IN ('pending','sent','failed')),
  CONSTRAINT ck_mail_logs_template CHECK (template IN ('verify_email','reset_password','test','notice')),
  CONSTRAINT ck_mail_logs_attempts CHECK (attempts >= 0)
);
-- 幂等键：NOT NULL + 唯一（可空的话 NULL 行不受约束，幂等静默失效）
CREATE UNIQUE INDEX uq_mail_logs_idem ON mail_logs (idempotency_key);
-- 排障队列：按状态取最近的一批
CREATE INDEX idx_mail_logs_status        ON mail_logs (status, created_at DESC, id DESC);
CREATE INDEX idx_mail_logs_quota_account ON mail_logs (quota_account_id);   -- 外键索引（SET NULL）
-- 暂不清理（拍板 §8.11 U8）：由 forum check 在 >50 万行时告警
