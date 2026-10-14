-- 0051_board_moderator_grown：版主任期的「已经卸任」标记 + 重复任命（交接单 C2）
--
-- `board_moderators`（0003 建）缺两样东西：
--
-- ① **卸任没有落点**。直接 `DELETE` 会丢掉「谁在什么时候被免了」—— 那是审计材料。
--    `DELETE /admin/boards/{id}/moderators/{user_id}` 的「免」因此是**置 grown_at**，不是删行；
--    审计里仍然逐条写 board.moderate.revoke（那才是给人看的流水）。
--
-- ② **重复任命会撞唯一键**。0003 的 `UNIQUE (board_id, user_id)` 是永久的，
--    而「免了再任命」是后台最常见的动作。改成部分唯一索引：
--      UNIQUE (board_id, user_id) WHERE grown_at IS NULL   —— 同一时刻只有一个**在任**行。
--
-- **这次迁移的真正代价，写在这里免得漏**：判定「这个人现在是不是版主」的三条 SQL
-- 都要带上 `m.grown_at IS NULL`。
--   · auth/pgsql/queries.go 的 ResolveSessionSQL 的 board_ids LATERAL
--   · auth/pgsql/queries.go 的 LoadActorSQL 的 board_ids 子查询
--   · forum/pgsql/access.go 的 ACLRowFor 的 EXISTS (SELECT 1 FROM board_moderators …)
-- 漏一处就会让卸任的人仍然有 board.moderate —— 那是权限泄漏，不是显示问题。

ALTER TABLE board_moderators ADD COLUMN grown_at timestamptz NULL;

-- 换索引：先建新的，再删旧的（反过来会留一个「两边都没有唯一约束」的窗口）。
ALTER TABLE board_moderators DROP CONSTRAINT IF EXISTS board_moderators_board_id_user_id_key;
CREATE UNIQUE INDEX uq_board_moderators_active ON board_moderators (board_id, user_id)
  WHERE grown_at IS NULL;

-- **必须补这一条**：上面删掉的唯一约束顺带提供了 (board_id, user_id) 的 btree，
-- 而它是 board_id 外键唯一一条**非部分**索引 —— 删掉之后启动自检（db.SelfCheck 的
-- 「外键列上没有可用索引」）会直接拒绝启动，2026-10-14 实测报
-- 「外键 board_moderators.fk_board_moderators_board 上没有可用索引」。
-- 部分索引（uq_board_moderators_active）**不算**：RI 查找用不了带谓词的索引。
-- 顺带也服务本域的查询：版主名单与在任判定都是 WHERE board_id = $1。
CREATE INDEX idx_board_moderators_board ON board_moderators (board_id);
