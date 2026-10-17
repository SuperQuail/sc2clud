-- 0008_message：一对一私信
--
-- 依赖：users（0002）。不做会话表：(low_id, high_id) 就是会话身份，规范化顺序由 CHECK 保证。
--
-- 索引说明（D4 §1.3）：
--   * 两侧都要 pair 索引 —— 否则 high 一侧的会话列表只能全表扫（30 秒轮询的热路径）；
--   * 两个未读部分索引**必须带 sender_id <> 自己**：read_at 是**收件人**的已读时间，
--     漏掉它会让「我发给对方、对方还没读」的消息计进我自己的未读角标（盲审 B3）；
--     deleted_by_* 也要进谓词：删掉的未读消息不该继续计数。

CREATE TABLE messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid          NOT NULL UNIQUE,
  low_id          bigint        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  high_id         bigint        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id       bigint        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            varchar(2000) NOT NULL,
  read_at         timestamptz   NULL,
  deleted_by_low  boolean       NOT NULL DEFAULT false,
  deleted_by_high boolean       NOT NULL DEFAULT false,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_messages_pair_order     CHECK (low_id < high_id),
  CONSTRAINT ck_messages_sender_in_pair CHECK (sender_id IN (low_id, high_id)),
  CONSTRAINT ck_messages_body_not_blank CHECK (btrim(body) <> '')
);

CREATE INDEX idx_messages_pair_low  ON messages (low_id,  high_id, id DESC);
CREATE INDEX idx_messages_pair_high ON messages (high_id, low_id,  id DESC);
CREATE INDEX idx_messages_unread_low  ON messages (low_id)
  WHERE read_at IS NULL AND deleted_by_low  = false AND sender_id <> low_id;
CREATE INDEX idx_messages_unread_high ON messages (high_id)
  WHERE read_at IS NULL AND deleted_by_high = false AND sender_id <> high_id;
-- 纯外键索引：sender_id 不在任何索引前导位
CREATE INDEX idx_messages_sender ON messages (sender_id);
