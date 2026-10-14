# 进度 · W-C7（任务：交接单第 4 节 C7 的三条已记录缺陷 + C8）

作用域：`forum/internal/forum/**`（除 handler.go 的路由块）、`forum/internal/notify/**`、
`forum/internal/platform/httpx/**`、本文件。基线 master = bac77af。

## 步骤

- [x] C8 盲测探针按新契约重写（blind_probe_test.go 未跟踪，先提交成回归资产）
  - 证据：`go test ./internal/forum/ -run TestBlind -v` → 14 条里 12 条 PASS；
    只剩两条是我故意留的**会红**断言（它们是 D3/D4 的靶子，修完即绿）：
    `TestBlindGuardsOnHTTP` 401 行「期望 HTTP 404，实际 403」（D4）、
    `TestBlindMalformedUUIDIsFourHundredNotFiveHundred` 737 行「期望 HTTP 400，实际 500」（D3）。
    改法：新增 `reviewVersion(id)` + `review(id, body)` 两个台子方法，判定请求一律走 `a.review`；
    `asActorPost` 多收一个 `expectedUpdatedAt`；X1 从「记录 500」改成「必须是 400」。
    `gofmt -l .` 无输出、`go vet ./internal/forum/` 退出 0；
    `go test ./internal/forum/ -run 'TestReview|TestEditBody|TestHandler|TestService'` → ok。
  - 下一步：D3 —— 在 `forum/internal/platform/httpx` 新增路径参数闸（名称待定，形如
    `ValidPathIDs(names ...string) gin.HandlerFunc`，非 uuid → `apperr.Invalid` 400），
    在 `forum/internal/forum/handler.go` 的 `Register` **第一行**用
    `rg = rg.Group("", httpx.ValidPathIDs("id", "sid"))` 挂一次；handler_test 加一条会红的用例。
  - 阻塞：无

- [ ] D3 非 uuid 路径参数 → 500（SQLSTATE 22P02 冒到 HTTP）
  - 证据：
  - 下一步：
  - 阻塞：无

- [ ] D4 无权编辑别人的主题返回 403 vs errors.go 注释「不区分」
  - 证据：
  - 下一步：
  - 阻塞：无

- [ ] M4 人工判定不落 review_events
  - 证据：
  - 下一步：
  - 阻塞：无

- [ ] M5 通知是消费时现读 topics 而不是判定时快照
  - 证据：
  - 下一步：
  - 阻塞：无

- [ ] M7 审核队列 DTO 缺 reviewer / reviewed_at
  - 证据：
  - 下一步：
  - 阻塞：无
