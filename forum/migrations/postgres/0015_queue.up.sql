-- 0015_queue.up.sql —— 任务队列（jobs）
-- 依据：d1-platform §6.1（DDL 与三个索引的真源）；数据库文档 §2 全局约定、§4.10。
-- 与数据库文档 §4.10 的差异以 d1 §6.1 为准：finished_at 不建（D1 的清理 SQL 不用它）。
--
-- **locked_by 必须有**（2026-10-13 数据库审计 D1 的修复）：worker 的 claim/done/retry/dead/recover
-- 五条 SQL 全部用 `locked_by = $instance` 做「只可能由持有者改自己那条」的判定，而本文件原先只在注释里
-- 提到它、没有建列 —— 结果是整个异步队列领不到任何任务（发信/搜索索引/图片 GC/通知全哑），
-- 而进程起得来、日志正常、HTTP 正常，表面上全绿。
-- 根因是「实现与迁移各写各的、且没有一条检查比对两边」；堵法是审计建议的第 2 条：
-- **所有原生 SQL 常量在真库 PREPARE**（SQL 引用了不存在的列，PREPARE 就会红）。

CREATE TABLE jobs (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type         text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  unique_key   text        NOT NULL DEFAULT '',
  status       text        NOT NULL DEFAULT 'pending',
  priority     int         NOT NULL DEFAULT 0,       -- 越大越优先
  attempts     int         NOT NULL DEFAULT 0,
  max_retry    int         NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_by    text        NOT NULL DEFAULT '',       -- 实例标识：领取时写自己；done/retry/dead 都带「= $instance」
  locked_until timestamptz NULL,                     -- 租约到期（领取时 now()+5min），崩溃恢复用
  last_error   text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_jobs_status    CHECK (status IN ('pending','running','done','dead')),
  CONSTRAINT ck_jobs_priority  CHECK (priority >= 0),
  CONSTRAINT ck_jobs_attempts  CHECK (attempts >= 0),
  CONSTRAINT ck_jobs_max_retry CHECK (max_retry >= 0),
  -- 队列不变量：只有 running 持有租约（领取时写 locked_until，成功/失败/恢复时清空）
  CONSTRAINT ck_jobs_lease     CHECK (status = 'running' OR locked_until IS NULL)
);

-- 必须是**部分**唯一索引：普通唯一索引会让任务 done 之后永远无法再次入队（d1 §6.1）
CREATE UNIQUE INDEX uq_jobs_unique_key ON jobs (unique_key)
  WHERE unique_key <> '' AND status IN ('pending','running');

-- 领取（d1 §6.2）：列序与子查询的 ORDER BY priority DESC, run_at, id 逐字同序
CREATE INDEX idx_jobs_claim   ON jobs (priority DESC, run_at, id) WHERE status = 'pending';
-- 崩溃恢复（d1 §6.4 每分钟）：WHERE status='running' AND locked_until < $now
CREATE INDEX idx_jobs_recover ON jobs (locked_until) WHERE status = 'running';
-- 清理（d1 §6.4 每小时）：done 超 7 天、dead 超 30 天，两段都按 (status, updated_at) 扫
CREATE INDEX idx_jobs_cleanup ON jobs (status, updated_at);

-- 每次领取/完成都改这一行（盲审-运行 71/73）：持续更新的表，收紧 autovacuum
ALTER TABLE jobs SET (autovacuum_vacuum_scale_factor = 0.02,
                      autovacuum_vacuum_threshold    = 1000);
