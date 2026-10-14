# 进度 · K-REL（关注功能 L5 + 通知实时性 L11）

> 作用域：新建 `forum/internal/follow/**`、`forum/internal/notify/**`、`forum/migrations/postgres/**`（**0040–0049**）、
> `web/src/ui/message/notice-nav.tsx`（角标）、`web/src/routes/messages.tsx`（只加实时刷新落点）。
> 不碰 `forum/internal/app/**`（接线归 Lead，写阻塞）、`forum/internal/{forum,auth,user,site}/**`、`web/src/app/**`。

## 依据（拍板原文）

- **L5** 「实现关注功能,但是暂时不需要做关注后的推送,算备用」→ 做**关注分区 / 关注用户**（表 + 端点 + 幂等 + 列表）；
  **不做推送**。分区页那格「成员/关注数」因此有真数据（不再是假 0）。
- **L11** 「老站已经有实现,参考其代码复现即可」→ 通知实时性照老站复现。**老站的做法（已读代码）**：
  `site/crates/sc2clud-web/src/pages_messages.rs:100-146` —— axum 的 `Sse`，一条 `tokio::broadcast`（进程内、容量 256），
  keep-alive 20s，响应头带 `x-accel-buffering: no`（nginx 会缓冲 SSE，不关就是「攒着不发」）；
  客户端 `site/crates/sc2clud-web/templates/inbox.html:242-276` —— `EventSource` 为主 + `setInterval(pull, 30000)` 轮询兜底。
  老站还明写了两条取舍（`site/AGENTS.md` §9 末行）：单进程 broadcast 够用，多实例要换跨进程（或靠轮询兜底）。

## 步骤

- [x] 起步：读 08-拍板记录 / 07-交接单、读老站 SSE 实现、确认迁移号段（当前最大 0022，0040–0049 空着）、写本骨架
  - 证据：`cmd /c dir /b /o:n forum\migrations\postgres` 最后一行 = `0022_appeals.up.sql`（0040–0049 未被占用）；
    `site/crates/sc2clud-web/src/pages_messages.rs:135-144` = `axum::response::sse::Sse` + `KeepAlive 20s` + `x-accel-buffering: no`；
    `site/crates/sc2clud-web/templates/inbox.html:265-275` = `EventSource` + `setInterval(pull, 30000)`
  - 下一步：`forum/migrations/postgres/0040_follows.{up,down}.sql` —— 建 `follows`（(follower_id,user_id) 与 (follower_id,board_id) 两条部分唯一索引、
    幂等 = `ON CONFLICT DO NOTHING`、计数现算不落列、外键各一条非部分索引）；再写 `forum/internal/follow/{types,service,handler}.go`
    + `follow/pgsql/pgsql.go`（端点：`GET/PUT/DELETE /boards/{slug}/follow`、`GET/PUT/DELETE /users/{handle}/follow`、`GET /me/following`）
  - 阻塞：无
