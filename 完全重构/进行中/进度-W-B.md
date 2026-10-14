# 进度 · W-B（交接单 §4.B 的前端小修 + 出图脚手架）

> 任务书：[`07-一次性完工交接单.md`](./07-一次性完工交接单.md) 第 4 节 **B**（B1–B6、B8）。
> **接手规则**：读完本文件 + `git log --oneline -8` 就能继续，不需要任何对话记录。
> 基线：master = `bac77af`，`cd web && pnpm check` 全绿（27 文件 / 141 用例）。
> 出图端口：**5229**（vite dev，preview 配置 5199 是共享入口别占）。收工跑 `cd web && pnpm typecheck && pnpm lint && npx vitest run`（**不跑 pnpm check**：它会 `pnpm build` 清空 dist，与并发施工互踩）。

## 作用域（交接单点名给我的）

- `web/src/routes/topic.tsx`、`web/src/routes/messages.tsx`、`web/src/lib/api/issues.ts`、
  `web/src/devroom/pages/13-issue/{issue-filter-bar,new-issue-dialog,issue-detail}.tsx`、
  `web/vite.preview.config.ts`（**被点名授权**的冻结文件）+ 新建的产品预览入口文件、
  `完全重构/开发必读.md`、本文件。
- **不碰**：`web/src/app/**`、`web/src/ui/**`、`web/src/lib/url.ts`。
- 三项**越界但任务点名**（记在这里，Lead 复核时知道为什么）：`web/src/devroom/pages/12-topic/issue-nudge.tsx`（四个入口要按 kind 各给一个 href）、
  `web/src/devroom/pages/12-topic/topic-view.tsx`（把 `issueHrefFor` 透给 IssueNudge）、
  `web/src/routes/issues.tsx`（B5 的 `onVote` 要由这一页接到 mutation 上）。

## 步骤

- [x] 第 0 步：进度骨架 + 提交（本文件）
  - 证据：`git log --oneline -1` → `e8c6daa`；`git status --short` 里只 add 了本文件。
  - 下一步：B2+`B6` 一起改 `web/src/routes/topic.tsx`：① 加 `issueHrefFor={(k) => appPath('issues?topic=' + t.id + '&kind=' + k)}`、删掉那两个只回执的 `onOpenFeedback/onOpenIssue`；
    ② `save` 的 onSuccess 里加 `invalidateQueries(qk.topic)` + 回执「正文已保存并重新提交审核（回到 pending）」，两句假话（"端点还没有"）删掉。
  - 阻塞：无

- [x] 第 1 步：B2 四个反馈入口改成真链接 + B6「重新提交审核」说实话（一个提交：两处都在 topic.tsx，改的是同一个组件调用）
  - 做了什么：`routes/topic.tsx` 把只回执的 `onOpenFeedback/onOpenIssue` 换成
    `issueHrefFor={(kind) => appPath('issues?topic=' + t.id + '&kind=' + kind)}` 与 `feedbackHref={appPath('issues?topic=' + t.id)}`；
    `save` 的 onSuccess 记下「这次保存就是重新提交」（`saved='draft'`），回执按服务端 `review_state` 说实话。
    为此 `topic-view.tsx` 加 `issueHrefFor` prop 并透给两处 `IssueNudge`；`issue-nudge.tsx` 加 `kindHref`（四个类型各一条地址）、
    `TopicViewProps.onOpenIssue` 改可选（有 href 就不再需要回执回调）。
  - 证据：`cd web && pnpm typecheck` → 无输出（exit 0）；
    `npx vitest run src/devroom/pages/12-topic/topic-view.test.tsx` → `Test Files 1 passed / Tests 6 passed`；
    第五个用例 `四个反馈入口各是一条带了各自类型的链接（B2）` 是新的，**先证明它会红**：把 `kindHref={issueHrefFor}` 临时去掉 →
    `AssertionError: expected '/issues?topic=t_1042' to be '/issues?topic=t_1042&kind=bug'`（1 failed），加回去即绿。
    全套 `npx vitest run` → `Test Files 27 passed (27) / Tests 142 passed (142)`。
  - 下一步：B1 改 `web/src/routes/messages.tsx` 的 `NOTICE_KINDS`：`{kind:'system',label:'系统通知'}` → `{kinds:['system','review','sanction','reward'],label:'系统通知'}`（其余三档单值），
    档位比较与 `fetchNotifications({kind})` 传 `kinds.join(',')`；后端 `notify/service.go:200 parseListKinds` 认逗号多值（值域见 `notify/kinds.go`）。
  - 阻塞：无

- [x] 第 1b 步（顺手，不动渲染）：修掉一个**在 bac77af 上就已经红**的测试抖动
  - 做了什么：`topic-view.test.tsx` 第一条用例等懒加载评论区只给了 `findBy` 默认 1s；
    全套并发跑时实测超过 1s → `Unable to find an element by: [data-testid="comment-total"]`。窗口放宽到 3s（断言一个字没改，与 `949be1c` 修 home.test 同一处理）。
  - 证据：`git stash push` 掉我这一轮的全部改动后跑 `npx vitest run` → `Tests 1 failed | 140 passed`，失败的就是这条
    （**所以不是我的改动弄红的**）；放宽窗口后同一条 → `Test Files 27 passed (27) / Tests 142 passed (142)`。
  - 下一步：见上一步。
  - 阻塞：无
- [x] 第 2 步：B1「系统通知」一档四类合一（system / review / sanction / reward）
  - 做了什么：`routes/messages.tsx` 的 `NOTICE_KINDS` 从「一个 `kind` 字符串」改成「`kinds: string[]`」；
    `resolveNoticeKind()` 把 URL 的 `?kind=` 归一（`?kind=review` 这种旧书签落到「系统通知」那一档，不会显示成「回复我的」）；
    请求串用 `kinds.join(',')`（后端 `notify/service.go:200 parseListKinds` 认逗号多值，值域 `notify/kinds.go`）。
  - 证据：新文件 `web/src/routes/messages.test.tsx`（2 条）——
    `npx vitest run src/routes/messages.test.tsx` → `Test Files 1 passed / Tests 2 passed`；
    **先证明它会红**：把那一档临时改回 `['system']` → `Tests 2 failed`（① 请求串不是四类 ② `?kind=review` 落错档）。
    全套 `npx vitest run` → `Test Files 28 passed (28) / Tests 144 passed (144)`；`pnpm typecheck` 无输出；`npx eslint src/routes/messages.tsx src/routes/messages.test.tsx` → exit 0。
  - 下一步：B3 改 `web/src/devroom/pages/13-issue/issue-filter-bar.tsx:19`：`created: '最早创建'` → `'最新创建'`（后端三种排序列全 DESC：`forum/internal/forum/pgsql/issues.go:110-113,157`）。
  - 阻塞：无
- [x] 第 3 步：B3 排序标签说实话 + B4 新建反馈弹窗那句过期话 + B5 评论赞/踩接上端点
  - 做了什么：① `13-issue/issue-filter-bar.tsx` 的 `SORT_LABEL.created`：`'最早创建'` → `'最新创建'`（后端三种排序列全 DESC）；
    ② `13-issue/new-issue-dialog.tsx:54` 删掉「（本页数据是本地的，用于验证交互闭环）」→「提交后会存到服务端」；
    ③ `lib/api/issues.ts` 加 `setIssueCommentVote(id, value: 1|-1|0)`（PUT/DELETE `issue-comments/{id}/vote`，返回 **VoteResultDTO**：`like_count/dislike_count/my_vote`，字段名照 `dto.go:209`）；
    `13-issue/issue-detail.tsx` 的 `IssueDetail` 加 `onVote?: (id, value) => void` 并传给 `CommentList`；
    `routes/issues.tsx` 加 `voteComment` mutation（同向再点 = 取消 → value 0 → DELETE）并接进 `onVote` 与失败回执列表。
  - 证据：`cd web && pnpm typecheck` → 无输出；
    `npx vitest run src/routes/issues.test.tsx` → `Tests 5 passed`，新增用例「评论的赞 / 踩」；
    **先证明它会红**：把 `onVote` 换成 `undefined` → `AssertionError: expected undefined to be 'DELETE'`（1 failed），接回来即绿。
    全套 `npx vitest run` → `Test Files 28 passed (28) / Tests 145 passed (145)`；
    `node scripts/check-size.ts` → `检查 261 个文件，超限 1 个，登记 1 个 / 文件体量门禁通过`（`routes/messages.tsx` 580 行，本来就在 PENDING 里）。
  - 下一步：B8 —— 产品页出图脚手架：新建 `web/product.html` + `web/src/preview/product.tsx`（真 Shell + MemoryRouter，可切路由）、
    `web/vite.preview.config.ts` 的 `rollupOptions.input` 加 `product: 'product.html'`，再写进 `开发必读 §8`。
  - 阻塞：无
