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

- [x] L5 第一步 · 关注域落地：迁移 0040 + `forum/internal/follow/{types,service,handler}.go` + `follow/pgsql/pgsql.go` + 用例
  - 做了什么：`follows` 表（user_id / board_id **恰好一个非空**，两条部分唯一索引做幂等，计数现算不落列）；
    九条路由：`GET/PUT/DELETE /boards/{slug}/follow`、`GET/PUT/DELETE /users/{handle}/follow`、
    `GET /me/following/{boards,users}`、公开读 `GET /boards/{slug}/followers`、`GET /users/{handle}/followers`；
    **不发任何通知**（拍板：推送算备用），用例钉住这一点。
  - 证据：`gofmt -l internal/follow` 空、`go vet ./internal/follow/...` 退出码 0、
    `go test ./internal/follow/... -count=1` → `ok forum/internal/follow 17.676s`（11 条用例）。
    **中途抓到一条真 bug**：游标取的是被关注者的 id，而排序键是 `(f.created_at, f.id)` —— 同一时间戳的分页里
    第一行每页重复出现（实测 ccc 出现两次）。改成 `f.id` 后 3 条一页一条地翻完、无重复无遗漏。
  - 下一步：`forum/internal/notify/stream.go` —— SSE `GET /api/v1/notifications/stream`（老站做法：`Sse` + `keep-alive` +
    `X-Accel-Buffering: no`；进程内 broadcast 容量 256），service 写完后 `notifyChanged(userID)` 发信号；用例在 `notify/stream_test.go`。
  - 阻塞：无（但**接线归 Lead**：`forum/internal/app/http.go:105` 要加一行
    `follow.NewHandler(m.Follow, auth.FromGin).Register(v1, m.requireLogin())`，`m.Follow` 在 `modules.go` 里 `follow.NewService(followpgsql.New(in.DB))`。见本文件末尾。）
## 需要 Lead 接线（我不碰 `forum/internal/app/**`）

1. **follow 域挂路由**：`forum/internal/app/modules.go` 的 `Modules` 加 `Follow *follow.Service`，
   装配处 `m.Follow = follow.NewService(followpgsql.New(in.DB))`；
   `http.go:105` 那一排后面加一行 `follow.NewHandler(m.Follow, auth.FromGin).Register(v1, m.requireLogin())`。
2. **SSE 已自带接线**（`notify.NewHandler` 里 `svc.publish = hub.Publish`），app 层**不需要改**。
3. **分区页「成员」格（I6 的后半）**：`web/src/routes/topic.tsx:415-419` 的 `toDesignBoard()` 仍把
   `member_count` 写死 0、`joined` 写死 false（那两行 `shortcut:` 注释现在已经是假话）。
   数据源已经有了：`GET /api/v1/boards/{slug}/follow` → `{ target, slug, following, follower_count }`。
   改法是给 `BoardSummary` 多传两个真值（该文件与 `topic.tsx` 都不在我的作用域）。
4. **前端关注按钮的落点**：我加在 `web/src/routes/board.tsx`（分区页，我的作用域内）。
   `topic.tsx` 右栏那颗 `BoardSummary` 的「关注分区」要接的话同第 3 条，同一个端点。
- [x] L11 · 通知实时性：照老站复现 SSE（`notify/stream.go` + `notify/stream_test.go`）+ service 加一条发出线
  - 做了什么：`GET /api/v1/notifications/stream`（requireLogin）——响应头 `text/event-stream` / `Cache-Control: no-cache` /
    `Connection: keep-alive` / **`X-Accel-Buffering: no`**（老站 `pages_messages.rs:140-144` 那条 nginx 坑），
    建立时先写 `: connected` 并 flush；keep-alive 15s（**必须小于 `http.Server.WriteTimeout`=30s**，
    `config/defaults.go:21`）；一条进程内广播 `streamHub`，容量 256（老站 `lib.rs:90` 同值），满了丢信号；
    事件体只带 `{changed:true}` —— **不推正文**（正文的渲染逻辑在 `GET /notifications` 里，只有一份，见 stream.go 文件头）。
    `notify.Service` 加 `publish func(userID)`：`Create` / `NotifySystem` / `Delete` 三处写完后 `notifyChanged`，
    `NewHandler` 里 `svc.publish = hub.Publish` 接上（**app 层不用改**）。`MarkRead` 不发（自己按的，响应里就知道结果）。
  - 证据：`gofmt -l internal/notify` 空、`go vet ./internal/notify/...` 退出码 0、
    `go test ./internal/notify/... -count=1` → `ok forum/internal/notify 31.285s` + `ok forum/internal/notify/pgsql 8.287s`
    （含新写的 5 条：头三项/只推自己的/事件体只有 changed/接线不断/hub 满了丢且删得掉）。
    另外 `notify/service_test.go` 的路由用例补了一条 `GET /api/v1/notifications/stream` 断言。
  - 下一步：前端落点 —— `web/src/lib/api/social.ts` 加 `noticeStreamUrl()`，`web/src/routes/messages.tsx` 里
    `EventSource`（收到信号 → 重取角标与当前档列表）+ **30s 轮询兜底**（老站 `inbox.html:275` 同值）。
  - 阻塞：无
- [x] 前端落点：`lib/api/follow.ts` + `lib/query/live.ts`（SSE+30s 兜底） + 分区页关注按钮/关注数 + 通知档的「实时/轮询」标记
  - 做了什么：
    · `lib/api/follow.ts`：`FollowState`（照 `follow/types.go` 抄）+ 分区/用户两套 GET/PUT/DELETE + 两个列表类型；
    · `lib/query/live.ts` 的 `useLiveNotices(enabled)`：`new EventSource(noticeStreamUrl())` 为主、
      `setInterval(refresh, 30000)` 兜底（老站 `inbox.html:275` 同值），收到 `unread` 信号就 invalidate
      角标与当前档列表；**断线不 close**（浏览器自己重连，老站同一条注释），只把状态退回「轮询」；
      没有 `EventSource` 的环境只剩轮询，不假装实时。
    · `lib/api/social.ts` 加 `noticeStreamUrl()`（前缀走 `appPath`，/ 与 /dev 同一份产物）；
    · `routes/messages.tsx`：通知档的标题行显示「实时同步」/「每 30 秒同步一次（推送未连上）」，页头显示「实时」/「每 30 秒刷新」；
    · `routes/board.tsx`：页头「N 帖子 · 今日 M · **N 关注**」（来自 `GET /boards/{slug}/follow`，不再是假 0）
      + `data-testid='board-follow'` 的关注/已关注按钮（幂等端点，回执直接写缓存，不回读）。
  - 证据：`npx vitest run` → **32 files / 164 tests passed**（基线 31 文件/162 用例，新增两条）；
    `node scripts/check-size.ts` → `检查 291 个文件，超限 1 个，登记 1 个 / 文件体量门禁通过`；
    新增 `routes/board.test.tsx`（关注数 7→点关注 8→点取关 7，PUT/DELETE 都记账）与
    `routes/messages.test.tsx` 的 SSE 用例（地址 /api/v1/notifications/stream、onopen 前说「每 30 秒同步一次」、
    onopen 后说「实时同步」、收到信号后重取）。
    **两条都证明过会红**：把 `es.addEventListener('unread', refresh)` 注释掉 → SSE 用例 red；
    把关注数写回 `' · 0 关注'` → 分区页用例 red（`Unable to find an element with the text: /7 关注/`）。
  - 下一步：个人主页/帖子页右栏的「关注」落点（`routes/profile.tsx:136` 与 `12-topic/board-summary.tsx` 的
    `onJoin`/成员格）—— 两个文件都不在我的作用域，端点与客户端都已就绪，见本文件末尾「需要 Lead 接线」第 3/4 条。
  - 阻塞：无（前端全量 lint 里有 **10 条别人文件的 error**：`web/scripts/shoot-kfe.ts`（未跟踪，另有 typecheck 错）、
    `routes/admin/{audit,reports,rewards,roles,settings,titles,users}.tsx` 的未用 import。我改的文件 lint 干净。）
- [x] 收工校验（我这一个包 + 我改的两个包）
  - 证据：`gofmt -l .` → **我改的文件一个都不在输出里**（列出的 7 个是别人在途的：
    `internal/forum/{dto.go,board_levels_test.go,hot_sort_test.go,issue_filter_test.go,path_order_test.go,revision_test.go}` 与
    `internal/forum/pgsql/boards.go`）；`go vet ./...` → **vet-exit=0**（全模块）；
    `go test ./internal/follow/... ./internal/notify/... -count=1` →
    `ok forum/internal/follow 17.750s` / `ok forum/internal/notify 27.952s` / `ok forum/internal/notify/pgsql 8.932s`；
    前端 `npx vitest run` → **32 files / 164 tests passed**；`node scripts/check-size.ts` 通过；
    `check-ui-usage` / `check-urls` / `check-controls` 三条门禁通过。
  - 下一步：等 Lead 接线后，用真后端验一次 SSE：`curl -N -b <cookie> http://127.0.0.1:8080/api/v1/notifications/stream`
    应看到 `: connected`，随后 15 秒一条 `: ping`；另开一个会话给别人发一条回复，流上应出现 `event: unread` + `data: {"changed":true}`。
  - 阻塞：**未出图**（本机没有后端：`127.0.0.1:8080` 没起；产品预览的桩数据在 `web/src/preview/product-fixture.ts`，
    它没有 `/boards/{slug}/follow` 这条桩，而那个文件不在我的作用域）。所以这一轮的验收走的是**组件级用例**
    （真组件 + 真渲染 + 记账断言），不是截图；出图这一步需要 Lead 或出图脚手架先给 follow 补一条桩。
