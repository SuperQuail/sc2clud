-- 0003_authz：会话 / 邮箱令牌 / 追加权限 / 审计 / 分区版主
--
-- d1-platform.md §8.1 的归属：roles / permissions / role_permissions / user_permissions /
-- audit_logs / board_moderators。其中**roles / permissions / role_permissions 已移到 0002_accounts**，
-- 因为 users.role_id NOT NULL 引用 roles(id)，而被引用的表必须先存在（理由见 0002 文件头）。
-- sessions / email_tokens 按 §8.1 该在 0002，同理被推迟到这里：它们引用 users，而 users 在 0002。
-- 两份文件合起来等于 §8.1 的 0002+0003，没有表被漏掉或落到别的域。
--
-- 本文件还补两处「跨文件外键」：images.owner_id → users（0002 建表时 users 还不存在），
-- board_moderators.board_id → boards（boards 在 0004 建，那条 ALTER 写在 0004_forum 文件里）。

-- ============================================================
-- sessions（登录会话）
-- ============================================================
CREATE TABLE sessions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash   bytea       NOT NULL,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   varchar(64) NOT NULL,
  ip           inet        NOT NULL,
  user_agent   text        NOT NULL DEFAULT '',
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sessions_hash_len CHECK (octet_length(token_hash) = 32)
);

-- 存的是 token 的 SHA-256（32 字节），客户端拿到的 id 是它的 base64url 前 16 字节（D2 §5.2）
CREATE UNIQUE INDEX uq_sessions_token   ON sessions (token_hash);
CREATE INDEX        idx_sessions_user   ON sessions (user_id);     -- FK：删用户级联
CREATE INDEX        idx_sessions_expires ON sessions (expires_at); -- 过期清理任务的范围扫 + FK

-- ============================================================
-- email_tokens（邮箱验证 / 找回密码）
-- ============================================================
CREATE TABLE email_tokens (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea       NOT NULL,
  purpose    text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_email_tokens_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT ck_email_tokens_purpose  CHECK (purpose IN ('verify','reset'))
);

CREATE UNIQUE INDEX uq_email_tokens_token ON email_tokens (token_hash);
CREATE INDEX        idx_email_tokens_user ON email_tokens (user_id);   -- FK：删用户级联
-- 「一个用户同一 purpose 只允许一条未消费的令牌」：让「重发」变成一次 upsert（D2 §10.2）。
-- 谓词只能引用列：拍板 §9.9 U19 明令 now() 不能进索引谓词（不是 IMMUTABLE，PG 会拒绝建索引），
-- 「未过期」的判定一律留在查询的 WHERE 里。
CREATE UNIQUE INDEX uq_email_tokens_live ON email_tokens (user_id, purpose) WHERE used_at IS NULL;

-- ============================================================
-- user_permissions（点对点追加权限）
-- ============================================================
CREATE TABLE user_permissions (
  user_id       bigint       NOT NULL,
  permission_id bigint       NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by    bigint       NULL     REFERENCES users(id)       ON DELETE SET NULL,
  granted_at    timestamptz  NOT NULL DEFAULT now(),
  expires_at    timestamptz  NULL,
  reason        varchar(200) NOT NULL,
  PRIMARY KEY (user_id, permission_id),
  CONSTRAINT ck_user_permissions_expires CHECK (expires_at IS NULL OR expires_at > granted_at),
  CONSTRAINT ck_user_permissions_reason  CHECK (btrim(reason) <> '')
);

-- user_id 侧刻意**没有** REFERENCES（D2 §5.7）：users 永不硬删，而提权记录是审计材料，
-- 不能因为删用户而消失；没有外键也就不需要 user_id 的单列索引。
-- 刻意**不建** (expires_at) 上的部分索引：谓词只能是 IMMUTABLE 的列条件，「已过期」是
-- 随时间增长的集合，清理任务扫全表（几百行）比维护一个索引更划算（D2 §5.7 末尾）。
CREATE INDEX idx_user_permissions_granted_by ON user_permissions (granted_by);    -- FK：SET NULL
CREATE INDEX idx_user_permissions_permission ON user_permissions (permission_id); -- FK：删权限点

-- 补 0002 欠下的外键：images.owner_id → users（建 images 时 users 还不存在）
ALTER TABLE images ADD CONSTRAINT fk_images_owner
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_images_owner ON images (owner_id);

-- ============================================================
-- audit_logs（审计）
-- ============================================================
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  action      varchar(64)  NOT NULL,
  target_type varchar(32)  NOT NULL,
  target_id   varchar(64)  NOT NULL,
  detail      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  ip          inet         NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_audit_logs_target_nonempty CHECK (btrim(target_id) <> '')
);

-- 三条索引对应三个真实查询（D2 §5.8）：actor= 筛选、target= 筛选、全量导出（时间范围 + 游标）。
-- target_id 存 public_id / key 字符串，不存自增 id（数据库文档 §2 第 3 条）。
CREATE INDEX idx_audit_logs_actor  ON audit_logs (actor_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_logs_target ON audit_logs (target_type, target_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_logs_dump   ON audit_logs (created_at DESC, id DESC);

-- ============================================================
-- board_moderators（分区版主 = board.moderate 的作用域来源）
-- ============================================================
CREATE TABLE board_moderators (
  board_id   bigint      NOT NULL,   -- FK 在 0004_forum 补（boards 那时才存在）
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by bigint      NULL REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,       -- NULL = 永久；「未过期」的判定留在查询里（拍板 §5.9 第 1 条）
  PRIMARY KEY (board_id, user_id)
);

-- 复合主键的第二列不算已索引（数据库文档 §12 第 1 条）：删用户要扫这一列，
-- 而且 D2 §6.4 的 Resolve 就是按 user_id 找这个人管哪些分区。
CREATE INDEX idx_board_moderators_user    ON board_moderators (user_id);
CREATE INDEX idx_board_moderators_granted ON board_moderators (granted_by);  -- FK：SET NULL
