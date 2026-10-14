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
  - 下一步：（已完成，见下一条 D3）
  - 阻塞：无

- [x] D3 非 uuid 路径参数 → 500（SQLSTATE 22P02 冒到 HTTP）
  - 证据：修法 = 新增 `httpx.ValidPathIDs("id","sid")`（`forum/internal/platform/httpx/bind.go`，
    非 uuid → `apperr.Invalid` 400），在 `forum/internal/forum/handler.go` 的 `Register` 第一行
    `rg = rg.Group("", httpx.ValidPathIDs("id","sid"))` 挂一次。
    **会红的证明**：把那一行临时换成 `_ = httpx.ValidPathIDs(...)` 后
    `go test ./internal/forum/ -run TestBlindMalformedUUID -v` →
    `blind_probe_test.go:737: 期望 HTTP 400，实际 500: {"code":"common.internal"}`；装回去 → PASS。
    两条 `GET /topics/not-a-uuid` 与 `PATCH /topics/not-a-uuid` 断言现在都 400；
    合法但不存在的 uuid 仍是 404（闸没把 404 变 400，`TestBlindInvalidParamsOnHTTP` 绿）。
    `go test ./internal/platform/httpx/` ok（新增 `TestValidPathIDsRejectsNonUUID`，含 sid 与
    「合法 uuid 照常进 handler」两侧）；`gofmt -l` 空、`go vet` 退出 0。
  - 下一步：D4 —— `forum/internal/forum/topics.go` 的 `requireTopicEdit`（560 行）
    把 `return apperr.ErrForbidden` 改成 `return ErrTopicNotFound`，让
    `TestBlindGuardsOnHTTP` 那条「无权者改别人的正文」得到 404 topic.not_found。
  - 阻塞：无

- [x] D4 无权编辑别人的主题返回 403 vs errors.go 注释「不区分」
  - 证据：**选了改行为**（保留 errors.go 的承诺）：`forum/internal/forum/topics.go` 的
    `requireTopicEdit` 最后一行 `apperr.ErrForbidden` → `ErrTopicNotFound`（UpdateTopic 的调用点
    也加了注释）。理由：这个函数的调用者都已经过了中间件的 `topic.edit.own`，拒绝只可能发生在
    别人的帖上；403 就是对普通用户承认「这条主题存在」。取舍写在 commit 里。
    **会红的证明**：把那一行临时换回 `apperr.ErrForbidden` →
    `go test ./internal/forum/ -run TestBlindGuardsOnHTTP -v` →
    `blind_probe_test.go:406: 期望 HTTP 404，实际 403`；换回 → PASS。
    探针台同时修了一处**测不准**：`ac.other` 原先没有 `topic.edit.own`，A3 那条测的是
    中间件的 403、根本到不了归属判定；现在给它这个权限，并且先放行主题（待审帖对别人本来
    就不可见，走的是 TopicRef 的 0 行）—— 这样测的才是 `requireTopicEdit`。
    `go test ./internal/forum/ -count=1` ok（59s，全包）；`gofmt -l internal/forum/` 空、`go vet` 退出 0。
  - 下一步：M7 —— `forum/internal/forum/pgsql/review_queue.go` 的 `reviewQueueColumns` 加
    `r.username, COALESCE(NULLIF(r.nickname,''), r.username), r.avatar_hash …` 与 `t.reviewed_at`
    （LEFT JOIN users r ON r.id = t.reviewed_by），`ReviewQueueRow` 加 `Reviewer *UserRow` +
    `ReviewedAt *time.Time`，DTO 加 `reviewer`/`reviewed_at` 两个 json 字段。
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
