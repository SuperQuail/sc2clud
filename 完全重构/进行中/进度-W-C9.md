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
  - 下一步：release —— `release/internal/release/handler.go` 的 `Register` 第一行加同一行
    （本域 {id} 三条：`GET /launcher/assets/{id}/go`、`PATCH /admin/launcher/releases/{id}`、
    `DELETE /admin/launcher/assets/{id}`），用例打 `GET /api/v1/launcher/assets/not-a-uuid/go`。
  - 阻塞：无
