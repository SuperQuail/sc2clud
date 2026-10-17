-- 0060_review_events_trigger_edit：编辑正文触发的 AI 审核要能落 review_events。
--
-- 背景（2026-10-16 修的那条链路）：编辑路径此前**不入队 AI 审核** —— UpdateTopic 只投
-- search:index，作者的新正文进待审槽（topic_revisions.pending_md）之后就再没有任何 AI 任务。
-- 修好之后编辑会入队 trigger='edit' 的 ai:review 任务，而 0020 的 ck_review_events_trigger
-- 只认 create|report|manual：判定写事件撞 23514（CHECK），整个事务回滚、任务反复重试 ——
-- 任务进得了队列却永远判不完。
--
-- 只放宽值域，不动已有行（没有别的约束依赖这三个值）。
ALTER TABLE review_events DROP CONSTRAINT ck_review_events_trigger;
ALTER TABLE review_events ADD CONSTRAINT ck_review_events_trigger
  CHECK (trigger IN ('create','report','manual','edit'));
