-- 0026_issue_kinds 的回滚：换回 CHECK 枚举（值域之外的行会让这条回滚失败 —— 那是刻意的：
-- 回滚前得先把新类型的数据处理掉，静默丢数据比回滚失败更糟）。
ALTER TABLE post_issues DROP CONSTRAINT IF EXISTS fk_post_issues_kind;
DROP INDEX IF EXISTS idx_post_issues_kind;
ALTER TABLE post_issues ADD CONSTRAINT ck_post_issues_kind
  CHECK (kind IN ('bug','feature','difficulty','other'));
DROP TABLE IF EXISTS issue_kinds;
