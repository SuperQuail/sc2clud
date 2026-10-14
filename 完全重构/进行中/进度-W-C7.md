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

- [x] M4 人工判定不落 review_events
  - 证据：`pgsql/review_queue.go` 新增 `InsertReviewEvent`（trigger 恒 'manual'、source/verdict/reason/
    actor_id/created_at；reason 截到 varchar(200)）+ `clipReason`；`forum/review_queue.go` 的
    `ReviewTopic` 事务里在 `InsertReviewAudit` 之后调一次，并新增常量 `ReviewSourceManual`。
    **会红的证明**：把那次调用临时换成 `_ = pgsql.InsertReviewEvent` →
    `review_queue_test.go:428: 人工判定必须落 review_events（M4）: no rows in result set`；装回 → PASS。
    新用例 `TestReviewTopicWritesReviewEvent` 钉住：判定前的 0 条、每次判定 +1、三列值、
    actor_id = 审核员、被拒的判定不留事件（同事务）、500 字理由被截到 200 而不是 22001 回滚。
    `go test ./internal/forum/ -run 'TestReviewTopicWritesReviewEvent|TestReviewQueue' -count=1` 5 条全 PASS；
    `gofmt -l internal/forum/` 空、`go vet ./internal/forum/` 退出 0。
  - 下一步：M5 —— `forum/internal/forum/review_queue.go` 的 `ReviewTopic` 里给
    `queue.TypeNotifyReview` 的 payload 补 `"state"` 与 `"text"`（判定那一刻的快照）；
    `forum/internal/notify/tasks.go` 的 `NotifyReview` 优先用 payload 里的快照，缺了才现读 topics
    （`CreateNotifyInput` 加 `State`/`Text` 两个字段）；`notify/pgsql` 的 ReviewTarget 保留兜底。
  - 阻塞：无

- [x] M5 通知是消费时现读 topics 而不是判定时快照
  - 证据：两处一起改。
    ① **判定时快照进 payload**：`forum/internal/forum/review_queue.go` 的 `notify:review` payload 加
    `"state"`/`"text"`（就是刚写进 topics 的那两个值）；`notify/tasks.go` 的 `CreateNotifyInput`
    加 `State`/`Text` 字段，`NotifyReview` 有快照用快照、没有（老 payload）才现读 topics。
    ② **审核结果是事件不是状态**：`notify/service.go` 的 `Create` 对带快照的通知不再写 `dedup_key`。
    实测（探针，reject 后紧接着 approve）：改前 = 1 条，payload `{"state":"approved"}`，
    拒绝理由「来源不明」**一个字都没有**；只改① = 1 条 `{"state":"rejected",...}`（不丢理由，
    但帖子明明已 approved，作者看到的是「未通过」）；①②都改 = 2 条，依次是
    `rejected/来源不明` 与 `approved` —— 与队列那边「不设 UniqueKey」的注释一致（两次判定两条通知）。
    **会红的证明**：`TestNotifyReviewCarriesSnapshotFromPayload` 在只改①时红在
    `两次判定必须两条通知…实际 1 条`；在①②都改之前它先红在 `必须带判定那一刻的快照`。
    forum 侧 `TestReviewTopicWritesReviewEvent` 另有一断言：payload 里 `state=rejected` 且 `text=来源不明`。
    `go test ./internal/forum/ ./internal/notify/ ./internal/platform/httpx/ -count=1` 三个包全 `ok`；
    `gofmt -l` 空、`go vet` 退出 0。
  - 下一步：（六条任务全部完成，见文末「收尾」）
  - 阻塞：无

- [x] 额外（顺手，不在清单里但同域同因）：`notify` 的「不带 ?kind= 的通知列表恒空」
  - 证据：`forum/internal/notify/service.go` 的 `parseListKinds` 对空串返回**无类型 nil**，
    pgx 把它当 NULL 发进 `listSQL` 的 `$4::text[]` —— `cardinality(NULL)` 与 `'x' = ANY(NULL)`
    都是 NULL，于是 `cardinality($4)=0 OR type = ANY($4)` 恒不成立。实测（探针）：
    表里 1 行、`ListNotifications` 直接返回 0 行；改成 `[]string{}` → 1 行。
    它同时是 `notify` 包两条**基线就红**的用例的根因（`TestListPagesWithoutGapsOrDupesOnTies`、
    `TestListFiltersAndHidesDeleted`，在 `git stash` 掉我的改动后一样红）。
    改成返回空切片 + 新增 `TestListWithoutKindReturnsEverything`（先红：`实际 0`，后绿）。
    `go test ./internal/notify/ -count=1` → `ok`（整包，36s）。
  - 下一步：M5 —— `forum/review_queue.go` 给 `queue.TypeNotifyReview` 的 payload 加
    `"state"`/`"text"`（判定那一刻的快照）；`notify/tasks.go` 的 `CreateNotifyInput` 加
    `State`/`Text` 两个字段，`NotifyReview` 有快照用快照、没有才现读。
  - 阻塞：无

- [x] M7 审核队列 DTO 缺 reviewer / reviewed_at
  - 证据：`pgsql/review_queue.go` 的 `reviewQueueColumns` 加 `t.reviewed_at` + 判 定人 6 列、
    `reviewQueueFrom` 加 `LEFT JOIN users r ON r.id = t.reviewed_by`、`ReviewQueueRow` 加
    `ReviewedAt *time.Time` / `Reviewer *UserRow`（可空外键照 issues.go 的指派人的写法），
    `ReviewQueueItemDTO` 加 `reviewer`（null = AI 判的）、`reviewed_at`、`review_verdict`
    （approve/reject/**null**；从 review_state 推导，不是新列 —— topics 只有三态）。
    **会红的证明**：把 LEFT JOIN 注释掉 → 新用例 `TestReviewQueueDTOCarriesReviewerAndVerdict`
    在 `丢失FROM子句项 (SQLSTATE 42P01)` 上红（说明它真的在取审阅人那一列）；
    旧 DTO 里根本没有 reviewer 字段，同一断言也会红在 `reviewer 应当是审核员 mod, 实际 <nil>`。
    用例同时钉住 JSON 三个键、未判定时三个字段都是 null、改判后 verdict 跟着变、
    `reviewed_by` 为空时 reviewer 是 null 而不是空壳对象。
    `go test ./internal/forum/ -run TestReviewQueue -count=1`：4 条全 PASS；`gofmt -l` 空、`go vet` 退出 0。
  - **修正（同一步，M7 复看）**：第一版把 `review_verdict` 从 `review_state` 推导 —— **错了**。
    前端契约不是这么定义的：`web/src/devroom/pages/15-admin/mock/content.ts:98` 写的是
    「最近一次判定的 verdict：ai + review = **AI 转人工**（队列里要高亮）」，值域是
    `approve|reject|review` 三档，而 `review_state` 只有三态、推不出 `review`；
    更糟的是第一版会显示成「AI 通过」而不是「AI 转人工」，正好把审核员最先要看的那一类盖掉。
    现在改成 `reviewQueueFrom` 里 `LEFT JOIN LATERAL (SELECT verdict, created_at, actor_id FROM
    review_events WHERE topic_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) ev ON true`，
    连 `reviewer` 也一起改从 `ev.actor_id` 取（AI 判定会写事件却不写 `topics.reviewed_by`，
    读后者等于说「没人判过」）；`reviewed_at = COALESCE(ev.created_at, t.reviewed_at)`（兜老数据）。
    取舍：`reviewer`/`reviewed_at`/`review_verdict` 三列**同源同取同不取**，不会出现「结论是 A 的、
    判的人是 B」。用例的对应断言改成「事件 actor 为空 → reviewer null 但 verdict=review」。
    `go test ./internal/forum/ ./internal/notify/ -count=1` → 两个包 `ok`（64s / 46s）。
  - 下一步：M4 —— `forum/internal/forum/pgsql/review_queue.go` 新增
    `InsertReviewEvent(ctx, tx, topicID, trigger, source, verdict, reason string, actorID *int64, now)`，
    在 `forum/internal/forum/review_queue.go` 的 `ReviewTopic` 事务里（`InsertReviewAudit` 之后）
    调一次：trigger='manual'、source='manual'、verdict=action、reason=note、actor_id=审核员。
  - 阻塞：无
