-- 0007_notify：站内通知 / 「不再通知」
--
-- 依赖：users（0002）。notifications.actor_id 是触发者（列表要显示头像昵称），
-- 它是 ON DELETE SET NULL，必须有单列索引（数据库文档 §12 第 1 条没有排除名单）。

-- ============================================================
-- notifications
-- ============================================================
CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id  uuid         NOT NULL UNIQUE,
  user_id    bigint       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   bigint       NULL     REFERENCES users(id) ON DELETE SET NULL,
  type       varchar(16)  NOT NULL,
  payload    jsonb        NOT NULL DEFAULT '{}'::jsonb,
  link       text         NOT NULL DEFAULT '',
  dedup_key  text         NOT NULL DEFAULT '',
  read_at    timestamptz  NULL,
  deleted_at timestamptz  NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_notifications_type
    CHECK (type IN ('reply','mention','like','reward','review','sanction','system')),
  CONSTRAINT ck_notifications_link_prefix CHECK (link = '' OR link LIKE '/%'),
  CONSTRAINT ck_notifications_dedup_prefix
    CHECK (dedup_key = '' OR
           dedup_key ~ '^(reply|mention|like|reward|review|sanction|system):(post|topic|comment|issue|donation|sanction|system):[0-9]+$')
);

-- 收件箱（游标：ORDER BY created_at DESC, id DESC），谓词只引用列
CREATE INDEX idx_notifications_inbox ON notifications (user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
-- 未读角标（一次 COUNT，只索引未读行）
CREATE INDEX idx_notifications_unread ON notifications (user_id)
  WHERE read_at IS NULL AND deleted_at IS NULL;
-- 纯外键索引：actor_id 不在任何索引前导位
CREATE INDEX idx_notifications_actor ON notifications (actor_id);
-- user_id 是 ON DELETE CASCADE 外键，必须有一条**不带谓词**的索引：上面 idx_notifications_inbox
-- 虽然也以 user_id 开头，但它是部分索引，引用完整性查找用不了它（数据库文档 §12 第 1 条 ②）。
-- 删用户是极低频动作（users 永不硬删，只有测试夹具会删），这条索引因此只是「删的时候别全表扫」。
CREATE INDEX idx_notifications_user ON notifications (user_id);
-- 同一事件只有一条通知；软删**不**解除占用（否则重试会在用户删除后复活）
CREATE UNIQUE INDEX uq_notifications_user_dedup ON notifications (user_id, dedup_key)
  WHERE dedup_key <> '';

-- ============================================================
-- notification_mutes（一行两义，由 type 区分：整类静音 / 单条内容静音）
-- ============================================================
CREATE TABLE notification_mutes (
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       varchar(16) NOT NULL,
  target_key varchar(64) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type, target_key),
  CONSTRAINT ck_notification_mutes_type
    CHECK (type IN ('reply','mention','like','reward','review','sanction','system','link')),
  CONSTRAINT ck_notification_mutes_key
    CHECK ((type =  'link' AND
             target_key ~ '^(post|topic|comment|issue|donation|sanction|system):[0-9]+$') OR
            (type <> 'link' AND target_key = ''))
);
