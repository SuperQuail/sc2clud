-- AI 审核：「审过没」一个 bool + 每次审核的留痕。
--
-- 第一版我写成 ai_reviewed_at + 「一天前审过才再审」，那是绕开这个 bool 的补丁：
-- 队列按 id 排、判违规不改状态，于是被判违规的几条永远占住窗口，队列再也不前进。
-- **复审由业务触发，不由时间触发**：作者改了正文就把 bool 置回 false（pgsql.ResetTopicReview）。
ALTER TABLE topics ADD COLUMN ai_reviewed boolean NOT NULL DEFAULT false;

-- 待审队列索引：过滤条件就这几个，队列长了也不会全表扫。
CREATE INDEX idx_topics_ai_queue ON topics (id)
  WHERE review_state = 'pending' AND visibility = 'normal' AND NOT ai_reviewed;

-- 留痕表：照老站 migrations/0029_ai_review.sql 的 ai_reviews。
-- 为什么值得一张表：出问题时要回答「当时发了什么、AI 回了什么、什么时候判的」，
-- 光看帖子当前状态答不出来；raw_response 留 2000 字以内，够复盘。
CREATE TABLE ai_reviews (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target_kind  text        NOT NULL,          -- post | comment
    target_id    bigint      NOT NULL,
    source       text        NOT NULL,          -- new_post | report | manual
    verdict      text        NOT NULL,          -- approve | pending | reject | error
    reason       text        NOT NULL DEFAULT '',
    raw_response text        NOT NULL DEFAULT '',
    model        text        NOT NULL DEFAULT '',
    ok           boolean     NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_reviews_target ON ai_reviews (target_kind, target_id, created_at DESC);