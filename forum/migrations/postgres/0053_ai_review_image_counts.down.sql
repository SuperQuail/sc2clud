-- 0053 的回滚：把两列去掉（只删存在的列，重跑 down 不该「成功」地什么也没做）。
ALTER TABLE review_events DROP COLUMN IF EXISTS image_count;
ALTER TABLE review_events DROP COLUMN IF EXISTS image_skipped;
