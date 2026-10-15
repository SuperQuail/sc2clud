# 进度 · FIX-PERM（D25 / D28 / D29 —— AI 审核预览与图片、默认权限树、手动激活开关）

> 任务书：`完全重构/进行中/10-dev排查-缺陷清单.md` 第 0 节（同源要求）与 §1e 的 D25 / D28 / D29。
> 环境与协议：`完全重构/进行中/07-一次性完工交接单.md` §1/§2/§3。基线：master = `f121c63`。
> 验证命令：**不跑 `pnpm check`**；前端 `pnpm typecheck && pnpm lint && npx vitest run`，
> 后端 `gofmt -l .` + `go vet ./...` + 单包 `go test -count=1`（Go 走 `.tools/go/bin/go.exe`，见交接单 §1）。
> 作用域：`web/src/devroom/pages/15-admin/screens/**`、`web/src/routes/admin/**`、`web/src/lib/api/admin*.ts`、
> `forum/internal/aireview/**`、`forum/internal/site/**`、`forum/internal/auth/**`、`forum/migrations/postgres/**`（0052+ 如需）、本文件。
> **不碰** Lead 专属：`web/src/app/router.tsx`、`app/shell.tsx`、`web/src/main.tsx`、`deploy/**`。

- [x] 第 1 步：D25② 实测「图片发不发」—— **结论：不发**（上行 payload 只有 system/user 两段纯文本）
  - 做了什么：`forum/internal/aireview/aireview_test.go` 新增 `TestOutboundPayloadHasNoImageField`（用带 `![封面](/img/<hash>)` 的 1 楼正文走一次真判定，断言上行两段里没有 `image_url`/`data:image`，并把 user 文本**逐字**钉成 `标题：<t>\n\n正文：\n<body>`）。顺带实测出**第二个真 bug**：模型按 schema 省略非必填的 `categories` 时 `ai.parse` 返回 nil → 写 `review_events.categories`（`NOT NULL DEFAULT '{}'`，0020:48）撞 23502，判定落不了库还反复重试。修两处：`platform/ai/ai.go` 的 `parse` 让 Categories 永不为 nil；`aireview/service.go` 在**唯一写库口**再兜一次（外呼口是注入点，假实现也得被兜住）。
  - 证据：
    ① 先证明会红：`go test -count=1 -run TestOutboundPayloadHasNoImageField ./internal/aireview/` → 实际红在「23502 categories」上（正是那条 nil bug；把 categories 修好后同一断言转绿），说明这条用例真的在跑真库真判定；
    ② `go test -count=1 ./internal/aireview/ ./internal/platform/ai/` → `ok forum/internal/aireview 11.541s` / `ok forum/internal/platform/ai 1.347s`（整包跑，不 -run 过滤）；
    ③ 代码侧同源证据：`aireview/sql.go` 的 `sqlSubject` 只取 `topics.title` + `posts(floor=1).content_md`，**不 JOIN `topic_images`**；`platform/ai/ai.go` 的 `Judge` 只组 `SystemMessage(prompt)` + `UserMessage(text)` 两条消息，没有任何多模态字段。**图片唯一的痕迹是正文里的 Markdown 字面量**（`![封面](/img/<hash>)`），模型看不到图。
  - 下一步：D25① 审核屏就地预览被审内容（后端 `reviewQueueColumns` 加 1 楼 `content_md` 全文 + 待审版本 `rv.pending_md`，DTO 出 `body_md`；`screens/review.tsx` 右栏改渲染全文与图片 Markdown）；然后 D29（站点开关联动两条路径）、D28（`resource.publish` 漏配 + 对照表）。
  - 阻塞：无

