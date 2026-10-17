# 进度 · FIX-AI2（D33 —— AI 审核屏四个缺口：真 payload 预览 / 样例可见可编辑 / 图片审核可验证）

> 任务书：`完全重构/进行中/10-dev排查-缺陷清单.md` §0（同源要求）与 §1h 的 **D33**；§1g 的 D25② 结论。
> 环境与协议：`完全重构/进行中/07-一次性完工交接单.md` §1/§2/§3。基线：master = `4b6f9b8`。
> 验证命令：**不跑 `pnpm check`**；前端 `pnpm typecheck && pnpm lint && npx vitest run`，
> 后端 `gofmt -l .` + `go vet ./...` + `go test ./... -count=1`（Go 走 `.tools/go/bin/go.exe`，见交接单 §1）。
> 作用域：`web/src/devroom/pages/15-admin/screens/**`、`web/src/routes/admin/**`、`web/src/lib/api/admin*.ts`、
> `forum/internal/aireview/**`、`forum/internal/forum/**`（只在需要读一条真帖正文时）、本文件。
> **不碰** `deploy/**` 与 Lead 专属三文件（`web/src/app/router.tsx` / `app/shell.tsx` / `web/src/main.tsx`）。

- [x] 第 1 步：把「发给模型的那一份」收成**唯一一个组装处**（后端）+ 三条会红的用例
  - 做了什么：
    ① 新增 `forum/internal/aireview/preview.go` —— 组装从此只有一处：`assemblePrompt`（system：配置留空用内置默认词，举报档优先 prompt_report）、
    `userText(prefix,title,body)`（user：举报前缀 + `标题：…` + `\n\n` + `正文：\n…`）、`reportPrefix`、`hasImageMarkdown`；
    `Service.Preview`（按 topic_id 现读正文，dry-run 不外呼）与 `Service.PreviewProbe`（连通测试样例那一路）都只经 `previewView` 一个出口。
    ② `service.go` 的 `ReviewTopic` 第 4 步改成调这三个函数（**真发的那条路与预览那条路现在是同一份代码**）；
    `Test` 收一个 `probe string` 入参（空串 = 默认样例，老调用方行为不变），默认样例常量从 `dto.go` 的 `testText` 搬成 `DefaultProbeSample`。
    ③ `sql.go` 的 `sqlSubject` 加一列 `topic_images` 计数（真判定与预览读**同一条 SQL** —— 预览要是另起一条 SELECT，两边就会各自漂）；
    ④ `dto.go` 新增 `PayloadView`（wire 形状）与 `payloadReq`；`ConfigView` 加 `probe_sample`（界面要能看见默认样例）。
    **图片那一条的两个数都给**：`has_image_markdown`（正文里有没有 `![..](..)` 字面量）与
    `image_attachment_count`（图集里挂着几张）—— 只给前一个，会让「正文没写字面量、图集里有图」的帖子看起来像没图。
  - 证据：
    ① **先红**（编译层）：`go vet ./internal/aireview/` → `preview_test.go:61:19: h.svc.Preview undefined (type *aireview.Service has no field or method Preview)`；
    ② **先红**（行为层，实现之后把 `userText` 改坏一次）：`go test ./internal/aireview/ -count=1 -run TestPreview` →
    `--- FAIL: TestPreviewMatchesWhatIsActuallySent … 预览的 user 拼起来与真发出去的不是同一份` 与
    `--- FAIL: TestPreviewReportPrefixIsSeparateAndMatchesSend … 举报复核这一档预览与真发的不是同一份`，随后还原；
    ③ 绿：`go test ./internal/aireview/ ./internal/app/ -count=1` → `ok forum/internal/aireview 15.743s` / `ok forum/internal/app 13.858s`；
    `gofmt -l .` 空、`go vet ./internal/aireview/ ./internal/app/` 无输出；
    ④ 同源的判据是**拿假外呼收到的东西逐字比**（`preview_test.go` 的 `TestPreviewMatchesWhatIsActuallySent`：
    `pv.UserPrefix+pv.UserTitle+"\n\n"+pv.UserBody == h.judge.text`），不是「两次都调用同一个函数」这种看不出来的说法。
  - 下一步：`forum/internal/aireview/handler.go` 挂 `POST /admin/ai/payload`（topic_id>0 走 Preview，否则走 PreviewProbe；空 body 合法）
    并让 `POST /admin/ai/test` 收 `{probe}`；再加一条 handler 层用例钉住「topic_id>0 时预览的就是那条帖的正文」。
  - 阻塞：无

- [ ] 第 2 步：handler 挂 `POST /admin/ai/payload` + `POST /admin/ai/test {probe}` + 前端客户端函数与类型
  - 下一步：`web/src/lib/api/admin-types.ts` 加 `AiPayloadView`、`admin.ts` 加 `fetchAiPayload`/`testAiConfig(probe?)`。
  - 阻塞：无
