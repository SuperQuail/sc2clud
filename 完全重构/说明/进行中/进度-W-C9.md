# 进度 · W-C9（任务：交接单 C9 —— 路径参数校验铺到所有域）

作用域：`forum/internal/{media,release,message,mail,title,report,site,reward}/handler.go`、
各域新增的 `pathguard_test.go`、本文件。基线 master = 3348bf5。

挂法（每个域 Register 第一行，与 W-C7 在 forum 域的做法一致）：

```go
rg = rg.Group("", httpx.ValidPathIDs("id"))
```

## 步骤

- [x] reward 挂闸 + 会红用例（这个域换了两次证法，见下）
  - 做了什么：`reward.Register` 第一行加 `rg = rg.Group("", httpx.ValidPathIDs("id"))`；
    本域 {id} 两条：`DELETE /rewards/{id}`、`POST /admin/rewards/{id}/verify`。新增 `reward/pathguard_test.go`。
  - 证据（证法一，**证不出红，作废**）：先写成「真请求 + 断言 400」，结果挂闸前就 PASS ——
    reward 的 `parsePublicID` 返回的 `ErrInvalidInput + {id: 格式不正确}` 与闸的 400 逐字节相同
    （日志 `http fail code=common.invalid_input status=400`）。
  - 证据（证法二，**红**）：改用「`requireLogin` 故意失败 + handler 接 nil `*Service`」：
    挂闸前 `go test ./internal/reward/ -run TestNonUUIDPathIDIsRejectedBeforeService -v` →
    `pathguard_test.go:44: 非 uuid 的路径 id 必须在鉴权与 service 之前被挡成 400，实际 401：{"error":{"code":"common.unauthorized"...}}`；
    挂闸后同一命令 PASS（400，且 service 一次没碰）。
    注：中途试过「nil service 会 panic」这条推理，实测**错** —— WithdrawDonation 在 nil 解引用之前
    就 parse 返回了 400，也是 PASS，所以那条也证不出红。
  - 下一步：八个域全部挂完，进入收工验证（见文末）。
  - 阻塞：无

- [x] site 挂闸 + 会红用例
  - 做了什么：`site.Register` 第一行加 `rg = rg.Group("", httpx.ValidPathIDs("id"))`；
    本域 {id} 三条：`POST /banners/{id}/dismiss`、`PATCH /admin/announcements/{id}`、
    `PATCH /admin/banners/{id}`。新增 `site/pathguard_test.go`。
  - 证据：**先红**（没挂闸）`go test ./internal/site/ -run TestNonUUIDPathIDIsBadRequest -v` →
    `pathguard_test.go:33: 非 uuid 的路径 id 必须是 400，实际 404：{"error":{"code":"common.not_found","message":"内容不存在"...}}`；
    挂闸后 `go test ./internal/site/ -count=1` → `ok forum/internal/site 18.791s`（整包）。
  - 下一步：reward —— `forum/internal/reward/handler.go` 的 `Register` 第一行加同一行
    （本域 {id} 两条：`DELETE /rewards/{id}`、`POST /admin/rewards/{id}/verify`）。
    **这个域要换一种证法**：service 的 `parsePublicID` 早就返回同一个 400（code/status/fields 与闸一致），
    所以「打非 uuid 断言 400」挂闸前就是绿的；用例改成拿 nil `*Service` 的 handler，
    断言非 uuid 在进 handler 之前就被挡成 400（挂闸前 → 调 nil service panic）。
  - 阻塞：无

- [x] report 挂闸 + 会红用例
  - 做了什么：`report.Register` 第一行加 `rg = rg.Group("", httpx.ValidPathIDs("id"))`；
    本域 {id} 一条：`PATCH /admin/reports/{id}`（`/admin/reports/batch` 是静态段）。新增 `report/pathguard_test.go`。
  - 证据：**先红**（没挂闸）`go test ./internal/report/ -run TestNonUUIDPathIDIsBadRequest -v` →
    `pathguard_test.go:38: 非 uuid 的路径 id 必须是 400，实际 404：{"error":{"code":"common.not_found","message":"内容不存在"...}}`；
    挂闸后 `go test ./internal/report/ -count=1` → `ok forum/internal/report 23.029s`（整包）。
  - 下一步：site —— `forum/internal/site/handler.go` 的 `Register` 第一行加同一行
    （本域 {id} 三条：`POST /banners/{id}/dismiss`、`PATCH /admin/announcements/{id}`、
    `PATCH /admin/banners/{id}`），用例打 `POST /api/v1/banners/not-a-uuid/dismiss`。
  - 阻塞：无

- [x] title 挂闸 + 会红用例
  - 做了什么：`title.Register` 第一行加 `rg = rg.Group("", httpx.ValidPathIDs("id"))`；
    本域 {id} 两条：`PATCH /admin/titles/{id}`、`POST|DELETE /admin/users/{id}/titles/{titleId}`。
    闸只点名 "id" —— `titleId` 是另一条 ID，但本域 `AssignTitle`/`UpdateTitle` 早已各自
    `checkPublicID`（语义是「找不到」404），不在这条任务的取舍里，所以不加第二个名字。
    新增 `title/pathguard_test.go`。
  - 证据：**先红**（没挂闸）`go test ./internal/title/ -run TestNonUUIDPathIDIsBadRequest -v` →
    `pathguard_test.go:34: 非 uuid 的路径 id 必须是 400，实际 404：{"error":{"code":"common.not_found","message":"内容不存在"...}}`；
    挂闸后 `go test ./internal/title/ -count=1` → `ok forum/internal/title 22.130s`（整包，含
    `TestRegisterRoutesDoNotConflict` —— 闸没有把路由注册弄坏）。
  - 下一步：report —— `forum/internal/report/handler.go` 的 `Register` 第一行加同一行
    （本域 {id} 一条：`PATCH /admin/reports/{id}`），
    用例打 `PATCH /api/v1/admin/reports/not-a-uuid`（body `{"state":"handled","note":"x"}`，要能让 Bind 过）。
  - 阻塞：无

- [x] mail 挂闸 + 会红用例
  - 做了什么：`mail.Register` 第一行加 `rg = rg.Group("", httpx.ValidPathIDs("id"))`；
    本域 {id} 三条都在 /admin 下：`PATCH /admin/mail/accounts/{id}`、`DELETE /admin/mail/accounts/{id}`、
    `POST /admin/mail/accounts/{id}/test`。新增 `mail/pathguard_test.go`。
  - 证据：**先红**（没挂闸）`go test ./internal/mail/ -run TestNonUUIDPathIDIsBadRequest -v` →
    `pathguard_test.go:34: 非 uuid 的路径 id 必须是 400，实际 404：{"error":{"code":"common.not_found","message":"内容不存在"...}}`；
    挂闸后 `go test ./internal/mail/ -count=1` → `ok forum/internal/mail 32.269s`（整包）。
  - 下一步：title —— `forum/internal/title/handler.go` 的 `Register` 第一行加同一行
    （本域 {id} 两条：`PATCH /admin/titles/{id}`、`POST|DELETE /admin/users/{id}/titles/{titleId}`；
    只点名 "id"，`titleId` 保持 service 里的 `checkPublicID`），
    用例打 `PATCH /api/v1/admin/titles/not-a-uuid`（body `{"name":"x"}`）。
  - 阻塞：无

- [x] message 挂闸 + 会红用例
  - 做了什么：`message.Register` 第一行加 `rg = rg.Group("", httpx.ValidPathIDs("id"))`；
    本域 {id} 路径一条：`DELETE /messages/{id}`（`GET/POST /messages/{handle}` 与 `/messages/{handle}/read`
    是 handle 不是 ID，闸只认点名的参数，所以不受影响）。新增 `message/pathguard_test.go`。
  - 证据：**先红**（没挂闸）`go test ./internal/message/ -run TestNonUUIDPathIDIsBadRequest -v` →
    `pathguard_test.go:29: 非 uuid 的路径 id 必须是 400，实际 404：{"error":{"code":"common.not_found","message":"内容不存在"...}}`；
    挂闸后 `go test ./internal/message/ -count=1` → `ok forum/internal/message 21.068s`（整包）。
  - 下一步：mail —— `forum/internal/mail/handler.go` 的 `Register` 第一行加同一行
    （本域 {id} 三条都在 /admin 下：`PATCH/DELETE /admin/mail/accounts/{id}`、
    `POST /admin/mail/accounts/{id}/test`），用例打 `DELETE /api/v1/admin/mail/accounts/not-a-uuid`。
  - 阻塞：无

- [x] release 挂闸 + 会红用例
  - 做了什么：`release.Register` 第一行加 `rg = rg.Group("", httpx.ValidPathIDs("id"))`；
    本域的 {id} 路径三条：`GET /launcher/assets/{id}/go`、`PATCH /admin/launcher/releases/{id}`、
    `DELETE /admin/launcher/assets/{id}`。新增 `release/pathguard_test.go`。
  - 证据：**先红**（没挂闸）`go test ./internal/release/ -run TestNonUUIDPathIDIsBadRequest -v` →
    `pathguard_test.go:31: 非 uuid 的路径 id 必须是 400，实际 404：{"error":{"code":"common.not_found"...}}`；
    挂闸后 `go test ./internal/release/ -count=1` → `ok forum/internal/release 26.728s`（整包）。
    注意：**release 从未 500 过** —— pgsql 的三处 public_id 原生 SQL（pgsql.go:129/229/248）
    都在前面 `uuid.Parse` 过了，非 uuid 走的是「查不到」404。闸在这里是把格式规则收回路由层，
    不是修一个现存 500。（交接单说这 8 个域「同样中招」，实测只有 media 中招，见文末「认账」。）
  - 下一步：message —— `forum/internal/message/handler.go` 的 `Register` 第一行加同一行
    （本域 {id} 一条：`DELETE /messages/{id}`；`:handle` 不是 ID 不校验），
    用例打 `DELETE /api/v1/messages/not-a-uuid`。
  - 阻塞：无

- [x] media 挂闸 + 会红用例
  - 做了什么：`media.Register` 第一行加 `rg = rg.Group("", httpx.ValidPathIDs("id"))`；
    本域的 {id} 路径三条：`POST /topics/{id}/images`、`DELETE /topics/{id}/images/{hash}`（只校验 id，
    hash 是图片哈希不是 uuid）、`DELETE /me/payment-channels/{id}`。新增 `media/pathguard_test.go`。
  - 证据：**先红**（没挂闸）`go test ./internal/media/ -run TestNonUUIDPathIDIsBadRequest -v` →
    `pathguard_test.go:32: 非 uuid 的路径 id 必须是 400（挂闸前是 500），实际 500：{"error":{"code":"common.internal"...}}`，
    服务端日志 `media: delete channel: 错误: 无效的类型 uuid 输入语法: "not-a-uuid" (SQLSTATE 22P02)`；
    挂闸后 `go test ./internal/media/ -count=1` → `ok forum/internal/media 62.046s`（整包）。
  - 下一步：release —— `forum/internal/release/handler.go` 的 `Register` 第一行加同一行
    （本域 {id} 三条：`GET /launcher/assets/{id}/go`、`PATCH /admin/launcher/releases/{id}`、
    `DELETE /admin/launcher/assets/{id}`），用例打 `GET /api/v1/launcher/assets/not-a-uuid/go`。
  - 阻塞：无
---

## 收尾（W-C9，2026-10-14）

**任务完成**：8 个域的 `Register` 第一行各挂一行
`rg = rg.Group("", httpx.ValidPathIDs("id"))`（与 W-C7 在 forum 域挂法一致），每域一个提交 + 一条会红用例。

| commit | 域 | 该域的 {id} 路径 | 挂闸前的实测状态（红） |
|---|---|---|---|
| `2887cca` | media | `POST /topics/{id}/images`、`DELETE /topics/{id}/images/{hash}`（hash 不校验）、`DELETE /me/payment-channels/{id}` | **500 common.internal（SQLSTATE 22P02）** |
| `aef46e3` | release | `GET /launcher/assets/{id}/go`、`PATCH /admin/launcher/releases/{id}`、`DELETE /admin/launcher/assets/{id}` | 404 |
| `20e3cc1` | message | `DELETE /messages/{id}`（`:handle` 不是 ID） | 404 |
| `148657f` | mail | `PATCH`/`DELETE /admin/mail/accounts/{id}`、`POST /admin/mail/accounts/{id}/test` | 404 |
| `5eeb908` | title | `PATCH /admin/titles/{id}`、`POST`/`DELETE /admin/users/{id}/titles/{titleId}` | 404 |
| `9a006aa` | report | `PATCH /admin/reports/{id}` | 404 |
| `f0e8704` | site | `POST /banners/{id}/dismiss`、`PATCH /admin/announcements/{id}`、`PATCH /admin/banners/{id}` | 404 |
| `cedfea1` | reward | `DELETE /rewards/{id}`、`POST /admin/rewards/{id}/verify` | 401（证法二；证法一见下） |

**收工验证（命令 + 结尾输出）**：

- `gofmt -l .`（`forum/`，用 `.tools\go\bin\gofmt.exe`）→ 无输出，`gofmt exit=0`；
- `go vet ./...` → `vet exit=0`；
- `go test ./internal/media/... ./internal/release/... ./internal/message/... ./internal/mail/... ./internal/title/... ./internal/report/... ./internal/site/... ./internal/reward/... -count=1`
  → `ok` × 8（media 50.9s / release 48.8s / message 37.8s / message/pgsql 27.9s / mail 50.4s / title 40.2s /
  report 41.1s / site 37.8s / reward 56.9s；mail|title|report|site 的 `pgsql` 子包 `[no test files]`），`domains exit=0`；
- `go test ./internal/app/ -count=1` → `ok forum/internal/app 15.466s`，7 条全 PASS
  （`TestEndToEndMainChain`、`TestAppealEndToEnd` 都在 —— 真路由装配没被弄坏），`app exit=0`。

**认账（与交接单 C9 的推断不一致的地方，以实测为准）**：

1. **只有 media 真中招**（非 uuid → 22P02 → 500，日志已贴在它那一条里）。交接单说这 8 个域「同样中招」，
   实测是 1/8。
2. 其余 7 域**各自在 service / pgsql 层早就收口了**：release 的三处 `public_id` 原生 SQL 前都有 `uuid.Parse`；
   title 有 `checkPublicID`；message / mail / report / site 用 `idgen.ParsePublicID` 后给 404；
   reward 的 `parsePublicID` 给的 400 与闸**逐字节相同**。
   闸在这 7 个域的价值不是修 500，而是把「对外 ID 一律 uuid」从「每个 service 各自记得写」收回**路由层**
   —— 这正是 `ValidPathIDs` 注释里写的理由（每条新路由都记得写一遍的规则等于没有规则）。
3. 用例的断言口径是**恰好 400**（闸的语义），不是「400 或 404」。所以除 reward 外 7 条在挂闸前都是红的
   （500 或 404 → 400），reward 的两次证法见它那一条。
4. **各域没有 `{sid}`**：`sid` 只在 forum 域（`/topics/{id}/sources/{sid}...`），W-C7 已挂。
5. 挂闸顺序：闸是**组中间件**，排在路由自己的 `requireLogin` 之前 —— 所以未登录时打一个非 uuid 的 `{id}`
   现在得到 400 而不是 401。用这条顺序差做成了 reward 的会红用例。

**没做的（留给 Lead / 别人）**：

- `title` 的 `:titleId` 没进闸（本任务给的挂法是只点名 `"id"`）。它现在由 `AssignTitle` 的 `checkPublicID`
  兜成 404；要不要统一成闸的 400 是语义取舍，没人拍过。
- 同形态的 `{id}` 还在 `auth`（`/admin/users/{id}` 一族）、`notify`（`/notifications/{id}`）、
  `appeal`（`AppealReview` 的 topic id）等域，**不在本次 8 域作用域**。抽查：notify 用 `idgen.ParsePublicID`（404）、
  appeal 走注入的 `topics.Ref`。要不要一律挂闸由 Lead 定。
- 没碰 `web/**`，没跑 `pnpm check`（前端不归本任务）。

**收尾动作**：

- `%TEMP%` 里 `forum-pg-*` 只有 2 个（`13:53`），都 <60 分钟，按规矩**没动**；需要清的 0 个；
- 没有起任何常驻进程（没跑 vite / chrome / 额外服务）：唯一的长任务是我自己的 `go test` 后台作业 `pwsh-1263`，
  已 `completed`（`exit code: 0`）。
