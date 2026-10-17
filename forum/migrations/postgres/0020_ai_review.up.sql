-- D7 AI 审核（完全重构/后端设计/d7-ai-review.md）：ai_config（单行）+ review_events + topics.review_source。
--
-- **AI 是第一道审核，人是最后一道**：新帖先给 AI 判一次，被举报到阈值再复审，拿不准/失败转人工。
-- 所以它不是独立业务线，而是**审核队列的一个判定来源**。

-- §2.1 单行配置（恒为 id=1）。API Key 走 chacha20poly1305 加密，与发信凭据**同一把主密钥**、同一套 Crypter。
CREATE TABLE ai_config (
    id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled           boolean  NOT NULL DEFAULT true,
    provider          text     NOT NULL DEFAULT 'deepseek'
                      CONSTRAINT ck_ai_config_provider CHECK (provider IN ('deepseek','openai_compatible')),
    base_url          text     NOT NULL DEFAULT 'https://api.deepseek.com',
    model             text     NOT NULL DEFAULT 'deepseek-flash',
    -- false = 快（Tool Calls 路径，tool_choice=required）；true = 推理（JSON Output 路径）。
    -- 官方明确「思考模式下不支持 tool_choice: required」，所以两条路径必须都实现。
    thinking          boolean  NOT NULL DEFAULT false,
    prompt            text     NOT NULL DEFAULT '',
    prompt_report     text     NOT NULL DEFAULT '',
    temperature       numeric(3,2) NOT NULL DEFAULT 0 CHECK (temperature BETWEEN 0 AND 2),
    timeout_ms        int      NOT NULL DEFAULT 20000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
    max_output_tokens int      NOT NULL DEFAULT 512 CHECK (max_output_tokens BETWEEN 64 AND 4096),
    -- strict 模式要求 base_url 用 https://api.deepseek.com/beta，且所有 function 都 strict: true。
    strict_mode       boolean  NOT NULL DEFAULT false,
    secret_cipher     bytea    NULL,   -- API Key 密文；**永不回显**
    secret_nonce      bytea    NULL,
    secret_updated_at timestamptz NULL,
    last_ok_at        timestamptz NULL,
    last_error        text     NOT NULL DEFAULT '',
    last_error_at     timestamptz NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- §5.1 判定来源：ai | manual | trusted（免审）。
ALTER TABLE topics ADD COLUMN review_source text NULL
  CONSTRAINT ck_topics_review_source CHECK (review_source IN ('ai','manual','trusted'));

-- §5.2 审核是**一串事件**，不是当前状态：当前状态在 review_state/review_note；这张表回答
-- 「它被谁、因为什么、判过几次」—— 「AI 先说通过、复审说违规」这种事实只能靠它留下来。
CREATE TABLE review_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    topic_id   bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    trigger    text   NOT NULL,
    source     text   NOT NULL,
    verdict    text   NOT NULL,
    reason     varchar(200) NOT NULL DEFAULT '',
    categories text[] NOT NULL DEFAULT '{}',
    model      varchar(64) NOT NULL DEFAULT '',
    latency_ms int    NOT NULL DEFAULT 0,
    actor_id   bigint NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_review_events_source  CHECK (source  IN ('ai','manual','trusted')),
    CONSTRAINT ck_review_events_verdict CHECK (verdict IN ('approve','reject','review')),
    CONSTRAINT ck_review_events_trigger CHECK (trigger IN ('create','report','manual'))
);
CREATE INDEX idx_review_events_topic ON review_events (topic_id, created_at DESC, id DESC);
-- 用量统计与「单帖当日调用次数」都走这条部分索引。
CREATE INDEX idx_review_events_ai ON review_events (created_at DESC) WHERE source = 'ai';
-- 待审队列：还没被审过的待审主题。
CREATE INDEX idx_topics_ai_queue ON topics (id)
  WHERE review_state = 'pending' AND visibility = 'normal' AND review_source IS NULL;