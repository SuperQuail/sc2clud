# 进度 · W-C9（任务：交接单 C9 —— 路径参数校验铺到所有域）

作用域：`forum/internal/{media,release,message,mail,title,report,site,reward}/handler.go`、
各域新增的 `pathguard_test.go`、本文件。基线 master = 3348bf5。

挂法（每个域 Register 第一行，与 W-C7 在 forum 域的做法一致）：

```go
rg = rg.Group("", httpx.ValidPathIDs("id"))
```

## 步骤

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
