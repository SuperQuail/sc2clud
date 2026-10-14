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
