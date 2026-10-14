-- 0026_board_moderator_grown 的回滚。
--
-- 「在任」的部分唯一索引换回全表唯一约束时**必须先把重复行清掉**：
-- 卸任过的行在部分索引下可以重复，回滚后它们会互相撞车。
-- 保留**最新的一条**（granted_at 最大、再按 id），删掉其余历史行 ——
-- 回滚是「退回只认识一张表的旧二进制」，旧二进制本来就没有卸任这个概念。
DELETE FROM board_moderators a
 USING board_moderators b
 WHERE a.board_id = b.board_id AND a.user_id = b.user_id
   AND (a.granted_at, a.id) < (b.granted_at, b.id);

DROP INDEX IF EXISTS uq_board_moderators_active;
ALTER TABLE board_moderators
  ADD CONSTRAINT board_moderators_board_id_user_id_key UNIQUE (board_id, user_id);
ALTER TABLE board_moderators DROP COLUMN IF EXISTS grown_at;
