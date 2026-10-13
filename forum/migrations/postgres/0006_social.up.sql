-- 0006_social：赞踩 / 收藏 / 拉黑 / 举报 / 禁言
--
-- 依赖：users（0002）、topics（0004）、boards（0004）。
-- likes 与 reports 是**多态**表：target_id 指向 topics / posts / users，PG 无法对它建外键
-- （数据库文档 §4.3 的取舍记账：拆成两张表会把「切换赞」的规则写两遍）。代价是孤儿行要靠
-- service 层在同一事务里清理 + 自检 SQL 兜（数据库文档 §12 第 7 条）。

-- ============================================================
-- likes（赞与踩同一张表；主题只有赞、没有踩）
-- ============================================================
CREATE TABLE likes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text        NOT NULL,
  target_id   bigint      NOT NULL,
  value       smallint    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_likes_target_type CHECK (target_type IN ('topic','post','issue','issue_comment')),
  CONSTRAINT ck_likes_value       CHECK (value IN (-1, 1))
);

-- 「我的票」与幂等切换的目标：一个用户对一个对象只有一行
CREATE UNIQUE INDEX uq_likes_user_target ON likes (user_id, target_type, target_id);
-- 计数、批量取我的票、孤儿自检（拍板 §5.9 第 5 条：多态表的 target_id 索引要自己建）
CREATE INDEX idx_likes_target ON likes (target_type, target_id);

-- ============================================================
-- bookmarks（收藏主题）
-- ============================================================
CREATE TABLE bookmarks (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  user_id    bigint      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  topic_id   bigint      NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, topic_id)   -- 原自然键：降为唯一
);

-- 收藏页按时间倒序翻（主键的 (user_id, topic_id) 列序服务不了 ORDER BY created_at）。
-- 本表只有两列 + created_at，没有 id 列；游标因此退化为 created_at（同一用户同一毫秒收藏两条
-- 才会并列，且每用户收藏量级是几十行，不构成翻页重复）。造一个 id identity 列只为了给游标兜底
-- 属于「以后可能要」，不建。
CREATE INDEX idx_bookmarks_user  ON bookmarks (user_id, created_at DESC);
-- 复合主键的第二列不算已索引：删主题要扫它
CREATE INDEX idx_bookmarks_topic ON bookmarks (topic_id);

-- ============================================================
-- blocks（拉黑；方向性明确：A 拉黑 B 不影响 B 看 A）
-- ============================================================
CREATE TABLE blocks (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  user_id        bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_user_id),   -- 原自然键：降为唯一
  CONSTRAINT ck_blocks_not_self CHECK (user_id <> target_user_id)
);

-- 复合主键的第二列不算已索引：删用户（级联）与「谁拉黑了我」都要扫它
CREATE INDEX idx_blocks_target ON blocks (target_user_id);

-- ============================================================
-- reports（举报；列名以拍板 §4 的 DDL 为准）
-- ============================================================
CREATE TABLE reports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   uuid         NOT NULL UNIQUE,
  target_type text         NOT NULL,
  target_id   bigint       NOT NULL,
  reason      varchar(500) NOT NULL,
  detail      varchar(1000) NOT NULL DEFAULT '',
  reporter_id bigint       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state       text         NOT NULL DEFAULT 'open',
  handler_id  bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  handled_at  timestamptz  NULL,
  handle_note varchar(500) NOT NULL DEFAULT '',
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_reports_target_type CHECK (target_type IN ('topic','post','user')),
  CONSTRAINT ck_reports_state       CHECK (state IN ('open','handled','dismissed')),
  CONSTRAINT ck_reports_handled     CHECK (
    (state = 'open' AND handler_id IS NULL     AND handled_at IS NULL) OR
    (state IN ('handled','dismissed') AND handler_id IS NOT NULL AND handled_at IS NOT NULL))
);

-- 同一人对同一对象只留一条**未处理**的举报（拍板 §4）：重复举报返回既有那条，不 409。
-- 谓词只引用列（state），没有 now()。
CREATE UNIQUE INDEX uq_reports_once     ON reports (reporter_id, target_type, target_id)
  WHERE state = 'open';
CREATE INDEX idx_reports_queue    ON reports (state, created_at DESC, id DESC);   -- 处理队列游标
CREATE INDEX idx_reports_reporter ON reports (reporter_id, created_at DESC, id DESC);
CREATE INDEX idx_reports_handler  ON reports (handler_id);                        -- FK：SET NULL
CREATE INDEX idx_reports_target   ON reports (target_type, target_id);            -- 多态，无外键

-- ============================================================
-- sanctions（分区级限期禁言）
-- ============================================================
CREATE TABLE sanctions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint       NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  board_id   bigint       NULL REFERENCES boards(id) ON DELETE CASCADE,   -- NULL = 全站
  action     text         NOT NULL DEFAULT 'reply',
  reason     varchar(200) NOT NULL DEFAULT '',
  until      timestamptz  NULL,                                          -- NULL = 永久
  created_by bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_sanctions_action CHECK (action IN ('post','reply','all'))
);

-- 发言前判定：user_id = $1 且（board_id IS NULL 或 = 本分区）；「未过期」的 until 比较留在查询里
CREATE INDEX idx_sanctions_user  ON sanctions (user_id, until);
CREATE INDEX idx_sanctions_board ON sanctions (board_id);      -- FK：删分区级联
CREATE INDEX idx_sanctions_by    ON sanctions (created_by);    -- FK：SET NULL
