-- 0009_title：头衔目录 / 持有关系 / 经验流水
--
-- 依赖与破环：titles 无法放在 users 之前建（titles.user_titles.granted_by 引用 users），
-- 而 users.equipped_title_id 又引用 titles。所以 users 那一列的**外键在这里补**
-- （0002_accounts 建表时只留了裸列 equipped_title_id，注释已写明）。
--
-- 与数据库设计 §4.11 的差异（以 d4-social.md §1.4 的最终版为准）：
--   titles 多了 public_id（端点按 id 寻址：/admin/titles/{id}，§2.3 禁止把自增 id 返给前端）
--   与 updated_at；user_titles 多了 public_id 之外的 granted_by / granted_at 已按最终版写。
--   exp_events.reason 的值域按 D4 六值。

-- ============================================================
-- titles（头衔目录；只归档不删除）
-- ============================================================
CREATE TABLE titles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid         NOT NULL UNIQUE,
  key         varchar(32)  NOT NULL UNIQUE,
  name        varchar(32)  NOT NULL,
  color       varchar(16)  NOT NULL DEFAULT '',
  description varchar(200) NOT NULL DEFAULT '',
  archived_at timestamptz  NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_titles_key   CHECK (key ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT ck_titles_color CHECK (color = '' OR color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT ck_titles_name  CHECK (btrim(name) <> '')
);

-- ============================================================
-- user_titles（多对多：一个用户可持多个头衔；佩戴的那一个在 users.equipped_title_id）
-- ============================================================
CREATE TABLE user_titles (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  user_id    bigint      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  title_id   bigint      NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  granted_by bigint      NULL REFERENCES users(id)      ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, title_id),   -- 原自然键：降为唯一
  CONSTRAINT ck_user_titles_not_self CHECK (granted_by IS NULL OR granted_by <> user_id)
);

CREATE INDEX idx_user_titles_title   ON user_titles (title_id);    -- 复合主键第二列不算已索引
CREATE INDEX idx_user_titles_granted ON user_titles (granted_by);  -- FK：SET NULL

-- ============================================================
-- exp_events（经验流水）
-- ============================================================
CREATE TABLE exp_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      int         NOT NULL,
  reason     varchar(32) NOT NULL,
  ref        varchar(64) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_exp_events_delta_nonzero CHECK (delta <> 0),
  CONSTRAINT ck_exp_events_reason
    CHECK (reason IN ('manual','register','topic','reply','like','reward','import')),
  CONSTRAINT ck_exp_events_ref CHECK (ref = '' OR ref ~ '^[a-z_]+:[0-9]+$')
);

CREATE INDEX idx_exp_events_user ON exp_events (user_id, created_at DESC, id DESC);
-- 幂等键：同一次事件只记一笔经验（队列重试、并发重放都不重复加）
CREATE UNIQUE INDEX uq_exp_events_user_reason_ref ON exp_events (user_id, reason, ref)
  WHERE ref <> '';

-- ============================================================
-- 补 0002 欠下的外键与索引：users.equipped_title_id → titles
-- 头衔被删除/归档时佩戴自动置空（旧站 repo_titles.rs:128 手工做的那件事，现在由外键保证）
-- ============================================================
ALTER TABLE users ADD CONSTRAINT fk_users_equipped_title
  FOREIGN KEY (equipped_title_id) REFERENCES titles(id) ON DELETE SET NULL;
CREATE INDEX idx_users_equipped_title ON users (equipped_title_id);   -- 纯 FK 索引（SET NULL）

-- ============================================================
-- users.nickname 的索引（D4 §4.14：GET /users/search 是「每次打字都调」的端点）
-- 列本身在 0002_accounts 建（varchar(20)，数据库设计 §4.1），这里只建索引。
-- ============================================================
-- 按昵称前缀查（用户在 /users/search 里输入时逐字符触发）。
-- varchar_pattern_ops 是必需的：默认操作符类在中文/非 C 排序规则下走不了 LIKE 'x%' 前缀
-- （D2 §5.10 的理由）。谓词只引用列，只索引 active 账号。
CREATE INDEX idx_users_nickname_lower ON users (lower(nickname) varchar_pattern_ops)
  WHERE status = 'active';
