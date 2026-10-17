-- 0027_board_reply_level：回帖门槛（拍板 08 · E1）。
--
-- 用户原话：「补全回帖门槛数据」。老站 sections 有两档角色门槛（post_min_role / reply_min_role，
-- 原项目功能清单 14.3），迁移时只搬了一档 min_post_level，于是公告区那条
-- 「只有管理员能发帖」的规则落到新站就丢了 —— 发帖门槛在、回帖门槛不在。
--
-- 与 min_post_level 完全同构（等级门槛，不是角色门槛）：0 = 不限。
-- 判定在 forum/acl.go 的 canSpeak：**按 action 取对应那一档**（post → min_post_level，
-- reply → min_reply_level）。两条路都要过各自的 ACL 与等级判定，顺序不变。
--
-- 回填：老站只留下了「发帖门槛」这一档数据，回帖门槛无从反推 —— 取与 min_post_level 相同
-- 的值是**保守**选择（新站原来就是拿发帖门槛判回帖的，回填后行为逐字不变）。
-- 要收紧就一条 UPDATE；这一列存在的意义正是「能分开配」。

ALTER TABLE boards ADD COLUMN min_reply_level int NOT NULL DEFAULT 0;
UPDATE boards SET min_reply_level = min_post_level WHERE min_reply_level <> min_post_level;

ALTER TABLE boards ADD CONSTRAINT ck_boards_min_reply_level CHECK (min_reply_level >= 0);
