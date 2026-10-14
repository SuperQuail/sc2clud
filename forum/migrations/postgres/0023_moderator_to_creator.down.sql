-- 0023_moderator_to_creator 的回滚：把 creator 改回 moderator。
-- **只在 creator 就是这条迁移造出来的时候**才回滚（否则会动到 0017 种下的内置角色）。
-- 判据：creator 的矩阵点集合等于「0017 给 creator 的 7 个点」说明它没被后台改过；
-- 更稳的判据不存在（roles 没有「由哪条迁移写入」的列），所以这里只做安全的一半：
-- 重新种一个空的 moderator 角色，让回滚后仍然可以再次向上迁移。
INSERT INTO roles (key, name, description, depth, is_system, priority)
VALUES ('moderator', '分区版主', '（已废弃，0023 回滚产物）', 2, false, 30)
ON CONFLICT (key) DO NOTHING;
