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
  - 证据：`git log --oneline -1` → `<待填>`；`git status --short` 里只 add 了本文件。
  - 下一步：B2+`B6` 一起改 `web/src/routes/topic.tsx`：① 加 `issueHrefFor={(k) => appPath('issues?topic=' + t.id + '&kind=' + k)}`、删掉那两个只回执的 `onOpenFeedback/onOpenIssue`；
    ② `save` 的 onSuccess 里加 `invalidateQueries(qk.topic)` + 回执「正文已保存并重新提交审核（回到 pending）」，两句假话（"端点还没有"）删掉。
  - 阻塞：无
