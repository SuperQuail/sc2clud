-- 0011_reward：赞赏（收款码 + 用户自报 + 管理员人工核验）
--
-- 硬约束：站点不经手资金。没有钱包、没有余额、没有支付回调（数据库设计 §4.6）。
-- 依赖：users（0002）、topics（0004）、payment_channels（0010）。
--
-- 与数据库设计 §4.6 的差异（以 d6-reward.md §3.2 的最终版为准）：
--   * 多了 channel_id（拍板 §8.11 U3：能回答「当时展示的是哪张码」）与 updated_at；
--   * 多了 ck_donation_records_verified：approved/rejected 必须有核验人与核验时间
--     （数据库文档 §12 第 6 条的自检就是这条约束的机器化）；
--   * 索引列序带 id 兜底（拍板 §5.1）。
-- 全表没有余额概念，所以不存在余额不变量。

-- ============================================================
-- donation_records（打赏申报单）
-- ============================================================
CREATE TABLE donation_records (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id    uuid         NOT NULL UNIQUE,
  donor_id     bigint       NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  recipient_id bigint       NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  amount_cents bigint       NOT NULL,
  txn_id       varchar(64)  NOT NULL DEFAULT '',
  post_id      bigint       NULL REFERENCES topics(id) ON DELETE SET NULL,
  channel_id   bigint       NULL REFERENCES payment_channels(id) ON DELETE SET NULL,
  state        text         NOT NULL DEFAULT 'pending',
  note         varchar(200) NOT NULL DEFAULT '',
  verified_by  bigint       NULL REFERENCES users(id) ON DELETE SET NULL,
  verified_at  timestamptz  NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_donation_records_amount   CHECK (amount_cents > 0),
  CONSTRAINT ck_donation_records_not_self CHECK (donor_id <> recipient_id),
  CONSTRAINT ck_donation_records_state    CHECK (state IN ('pending','approved','rejected','withdrawn')),
  CONSTRAINT ck_donation_records_verified CHECK (
    (state IN ('pending','withdrawn') AND verified_by IS NULL     AND verified_at IS NULL) OR
    (state IN ('approved','rejected') AND verified_by IS NOT NULL AND verified_at IS NOT NULL))
);

-- 管理核验队列（游标：列序 = 排序键序）
CREATE INDEX idx_donation_records_queue
  ON donation_records (state, created_at DESC, id DESC);
-- 收入侧：主页/统计按收款人扫（统计只累加作者同意公开的记录）
CREATE INDEX idx_donation_records_recipient
  ON donation_records (recipient_id, state, created_at DESC, id DESC);
-- 支出侧：我发出的申报（不过滤 state）
CREATE INDEX idx_donation_records_donor
  ON donation_records (donor_id, created_at DESC, id DESC);
-- 纯外键索引（PG 不自动建；数据库文档 §12 第 1 条会检查）
CREATE INDEX idx_donation_records_post     ON donation_records (post_id);
CREATE INDEX idx_donation_records_channel  ON donation_records (channel_id);
CREATE INDEX idx_donation_records_verifier ON donation_records (verified_by);

-- ============================================================
-- user_donation_settings（一行一人；三个开关 + 文案）
-- ============================================================
CREATE TABLE user_donation_settings (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  user_id        bigint       UNIQUE REFERENCES users(id) ON DELETE CASCADE,   -- 原自然键：降为唯一
  show_channels  boolean      NOT NULL DEFAULT false,   -- 展示收款码（旧站默认关）
  records_public boolean      NOT NULL DEFAULT false,   -- 我收到的打赏可公开（旧站默认关）
  notice_visible boolean      NOT NULL DEFAULT true,    -- 显示打赏提示文案
  notice_text    varchar(200) NOT NULL DEFAULT '',      -- 空 = 用 donation_notice_defaults 里那一行
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);
-- user_id 是主键首列 → 外键级联路径已覆盖，不另建索引。

-- ============================================================
-- donation_notice_defaults（按渠道的默认提示文案）
-- ============================================================
CREATE TABLE donation_notice_defaults (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- ent 实体必须有 id；原自然键降为 UNIQUE
  channel    text         UNIQUE,   -- 原自然键：降为唯一
  text       varchar(200) NOT NULL DEFAULT '',
  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_donation_notice_defaults_channel
    CHECK (channel IN ('default','wechat','alipay','other'))
);
