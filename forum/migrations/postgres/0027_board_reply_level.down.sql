-- 0027_board_reply_level 的回滚：把回帖门槛这一列删掉（回帖回到用 min_post_level 判）。
ALTER TABLE boards DROP CONSTRAINT IF EXISTS ck_boards_min_reply_level;
ALTER TABLE boards DROP COLUMN IF EXISTS min_reply_level;
