-- 0016_search.up.sql —— 搜索派生表（topic_search）
-- 依据：d1-platform §8.1；d5-content §6.5（DDL 真源）；拍板 §8.5（词素 = 单字 + 2-gram）、§8.6（删掉 pg_trgm）。
-- 这张表不进 ent 实体（拍板 §8.9）：它是派生表，只由 search 包的 SQL 维护，可重建。

CREATE TABLE topic_search (
  topic_id   bigint PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
  title      varchar(200) NOT NULL,
  body_text  text NOT NULL DEFAULT '',   -- 1 楼正文的纯文本（去 markdown），可重建
  tokens     text NOT NULL DEFAULT '',   -- Tokenize(title + ' ' + body_text)：单字 + bigram，Go 侧切好
  -- 生成列只能用 IMMUTABLE 表达式（拍板 §5.9 第 3 条）：to_tsvector(regconfig,text) / setweight / || 都是
  tsv        tsvector GENERATED ALWAYS AS (
               setweight(to_tsvector('simple', title),  'A') ||
               setweight(to_tsvector('simple', tokens), 'B')
             ) STORED,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 只有这一个 GIN：单字与 bigram 都在 tokens 里，两档查询都走它。
-- 没有 tokens 的 trgm 索引，也没有标题的 gin_trgm_ops —— 拍板 §8.6 整块删掉了 pg_trgm（没有查询用它）。
CREATE INDEX idx_topic_search_tsv ON topic_search USING gin (tsv);

-- 搜索任务每次重建都整行改写（d5 §6.7）：收紧 autovacuum（盲审-运行 73）
ALTER TABLE topic_search SET (autovacuum_vacuum_scale_factor = 0.02,
                              autovacuum_vacuum_threshold    = 1000);
