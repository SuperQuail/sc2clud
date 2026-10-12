-- 0010_media：收款码渠道（本域另外两张表 images / default_avatars 在 0002_accounts）
--
-- d1-platform.md §8.1 把 0002 标给「users / sessions / email_tokens」、把 0010 标给
-- 「images / default_avatars / payment_channels」。但 users 的三根头像列都引用 images(hash)，
-- 所以 images / default_avatars 必须提前到 0002（理由见该文件头），本文件只剩 payment_channels，
-- 以及 users.default_avatar_hash 的补列。
--
-- 收款码可见性（拍板 §8.7）：图固定私有（images.visibility = 2 语义），
-- 判定只发生在渠道读端点 GET /users/{handle}/channels 一处，由后端按身份放行。

-- ============================================================
-- payment_channels（用户的收款码渠道；每用户 ≤5，上限在 service 层）
-- ============================================================
CREATE TABLE payment_channels (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  label      varchar(32) NOT NULL,
  image_hash char(64)    NOT NULL REFERENCES images(hash) ON DELETE RESTRICT,
  sort       int         NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_payment_channels_label   CHECK (btrim(label) <> ''),
  CONSTRAINT ck_payment_channels_sort    CHECK (sort >= 0)
);

-- 主页/打赏弹窗按 (user_id, sort) 取列表，同时也是 user_id 的外键索引
CREATE INDEX idx_payment_channels_user ON payment_channels (user_id, sort);
CREATE INDEX idx_payment_channels_image ON payment_channels (image_hash);   -- FK：RESTRICT

-- ============================================================
-- 补 0002 欠下的两件事：users.default_avatar_hash 的列、外键与索引
-- 拍板 §8.8：注册时分配一次并写回，之后永不重算（重算会让头像变）
-- 拍板 §9.11 U12：它可空 + 单列 FK 索引（ON DELETE SET NULL，不加索引会红）
-- ============================================================
ALTER TABLE users ADD COLUMN default_avatar_hash char(64) NULL
  REFERENCES images(hash) ON DELETE SET NULL;
CREATE INDEX idx_users_default_avatar ON users (default_avatar_hash);
