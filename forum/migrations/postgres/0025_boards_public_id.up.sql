-- 0025_boards_public_id：给 boards 补一列对外 ID（交接单 C2）
--
-- 为什么必须补：`httpx.ValidPathIDs("id", "sid")` 是一道**组中间件**，挂在 /api/v1 的 forum 域上 ——
-- 它要求所有点名过的 {id} 路径参数是对外 ID（uuid）。而 boards 是唯一一张只有自增主键、
-- 没有 public_id 的业务表（迁移 0004 建它时按「表驱动、slug 就是对外的键」设计）。
--
-- 三条路里选这一条的理由：
--   ① 用 slug 当路径参数 —— 但**改 slug 等于废掉所有外链**（ent 的 board.go 原话），
--      而后台的分区编辑界面里 slug 是可改字段，把「不可变」建立在一个可改字段上迟早出事；
--   ② 用自增 id —— 全站对外 ID 一律 uuid 是拍板 §21.1 的硬规则（自增 id 不出现在 API 里）；
--   ③ 补一列 public_id —— 本文件。
--
-- 用 DEFAULT gen_random_uuid() 而不是「加列 → 回填 → 设 NOT NULL」三步：
-- PostgreSQL 13+ 的 ADD COLUMN ... DEFAULT <volatile> 会给**已有行**逐行求值并直接写成 NOT NULL，
-- 一句 DDL 就够；分三步写反而留下一个「中间窗口里新插的行 public_id 是 NULL」的形状。
-- 依赖：0001_extensions 已建 pgcrypto（gen_random_uuid 的来源）。

ALTER TABLE boards
  ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid();

-- 与 uuid 列的唯一约束：UNIQUE 索引同时是「按 public_id 查一行」的访问路径，
-- 所以不需要再补一条普通索引。
ALTER TABLE boards ADD CONSTRAINT uq_boards_public_id UNIQUE (public_id);
