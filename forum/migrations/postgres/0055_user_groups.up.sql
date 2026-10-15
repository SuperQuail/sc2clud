-- 0055_user_groups.up.sql —— 用户组系统（D38，2026-10-15 用户拍板）。
--
-- 用户原话：「当时我们还希望有另一套用户组系统，可指定只有特定用户可以发言或者可以回帖」。
-- 它是白名单粒度再细一层的**加法授权**：分区 ACL 白名单开着时，把某个组授了 can_post/can_reply，
-- 组成员就多一条可发/可回的路径（基线角色那行照旧）。既有 board_acls **一行不动** —— 加
-- board_group_acls 并列，判定在 forum/acl.go 合流：显式 deny（角色行或组行任一层）终局，
-- 否则（角色行 can || 组行 can）→ 等级门槛；acl_enabled=false 时整块 ACL（含组）都不生效。

-- ============================================================
-- user_groups（审计列照 0054 mail_templates 的形状：updated_by NULL = 系统动作）
-- ============================================================
CREATE TABLE user_groups (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- ent 实体必须有 id（0014/0050 同款）
  public_id   uuid        NOT NULL DEFAULT gen_random_uuid(),        -- 对外 ID 一律 uuid（0050 同款）
  key         varchar(32) NOT NULL,                                  -- 建后不可改 = 界面上的稳定标识
  name        varchar(32) NOT NULL,
  description varchar(200) NOT NULL DEFAULT '',
  created_by  bigint      NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by  bigint      NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_user_groups_key CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,31}$')
);
ALTER TABLE user_groups ADD CONSTRAINT uq_user_groups_public_id UNIQUE (public_id);
ALTER TABLE user_groups ADD CONSTRAINT uq_user_groups_key UNIQUE (key);
-- 纯外键索引（SET NULL 要按列找行）
CREATE INDEX idx_user_groups_created_by ON user_groups (created_by);   -- FK：SET NULL
CREATE INDEX idx_user_groups_updated_by ON user_groups (updated_by);   -- FK：SET NULL

-- ============================================================
-- user_group_members（组员名单；删组 / 删用户都级联 —— 判定按名单直查）
-- ============================================================
CREATE TABLE user_group_members (
  id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- ent 实体必须有 id；自然键降为唯一
  group_id bigint      NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id  bigint      NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  added_by bigint      NULL REFERENCES users(id)          ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)   -- 自然键降为唯一（id 才是主键）
);
CREATE INDEX idx_user_group_members_user     ON user_group_members (user_id);    -- FK：删用户级联 +「他在哪些组」
CREATE INDEX idx_user_group_members_added_by ON user_group_members (added_by);   -- FK：SET NULL

-- ============================================================
-- board_group_acls（分区 × 组；形状照 0004 board_acls 逐字抄 —— 矛盾 CHECK 同款）
-- ============================================================
CREATE TABLE board_group_acls (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- ent 实体必须有 id；自然键降为唯一
  board_id   bigint      NOT NULL REFERENCES boards(id)      ON DELETE CASCADE,
  group_id   bigint      NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  can_post   boolean     NOT NULL DEFAULT false,
  can_reply  boolean     NOT NULL DEFAULT false,
  deny_post  boolean     NOT NULL DEFAULT false,
  deny_reply boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, group_id),
  CONSTRAINT ck_board_group_acls_no_contradiction
    CHECK (NOT (deny_post AND can_post) AND NOT (deny_reply AND can_reply))
);
CREATE INDEX idx_board_group_acls_group ON board_group_acls (group_id);   -- FK：删组级联；(board_id,group_id) 由 UNIQUE 覆盖