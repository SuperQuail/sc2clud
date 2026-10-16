-- ============================================================
-- 0015 后端补完：用户组「禁止发言」语义 + 经验规则所需的列
-- 纯加法。
-- ============================================================

-- 组规则原来只有「允许」（白名单加成）。现在补「禁止」：
--   deny_post / deny_reply = 1 时，该组成员在本分区**禁止**发帖/回帖，
--   且禁止优先于角色门槛与其它组的允许（更精确的限制）。
ALTER TABLE group_section_rules ADD COLUMN deny_post  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_section_rules ADD COLUMN deny_reply INTEGER NOT NULL DEFAULT 0;
