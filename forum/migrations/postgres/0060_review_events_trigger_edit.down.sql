-- 0060 的回滚：必须先把 trigger='edit' 的判定行删掉，才能还原回三值约束
--（否则 ADD CONSTRAINT 会被既有行顶成 23514，回滚卡在半路）。
--
-- 为什么删行而不是改写：值域里没有能表达「编辑触发的判定」的另一个值，
-- 改写成 create / report 都是**伪造事实**（那条判定不是发帖或举报触发的）。
-- 这些行只有 review_events 自己持有（topic_id 是入向外键，没有别的表引用判定行），
-- 删掉丢的只是这几条判定历史。
DELETE FROM review_events WHERE trigger = 'edit';

ALTER TABLE review_events DROP CONSTRAINT ck_review_events_trigger;
ALTER TABLE review_events ADD CONSTRAINT ck_review_events_trigger
  CHECK (trigger IN ('create','report','manual'));
