# 进度 · W-FI（交接单 §4.F 的 DevRoom 入口核实 + §4.I 的前端欠账 11 条）

> 任务书：[`07-一次性完工交接单.md`](./07-一次性完工交接单.md) 第 4 节 **F**（F1/F2/F3）与 **I**（I1–I8）。
> **接手规则**：读完本文件 + `git log --oneline -8` 就能继续，不需要任何对话记录。
> 基线：master = `3c59b5f`，`cd web && pnpm typecheck && pnpm lint && npx vitest run` 全绿
> （typecheck 无输出 exit 0 / lint 18 warnings 0 errors / **28 文件 146 用例**）。
> 出图端口：**vite dev 5239、Chrome CDP 9243**（5199/5202 是共享入口，5229/9233 是 W-B 的，别占）。收工按 PID 关掉自己起的进程。
> 验证命令：**不跑 `pnpm check`**（它会 `pnpm build` 清空 dist，与并发施工互踩）；跑
> `pnpm typecheck && pnpm lint && npx vitest run`，出图/门禁单独跑。

## 作用域（交接单点名给我的）

- `web/src/ui/dev-entry.tsx`、`web/src/ui/comment/**`、`web/src/ui/rich/**`、`web/src/ui/message/notice-settings.tsx`
- `web/src/devroom/pages/14-home/states.tsx`、`web/src/devroom/pages/15-admin/admin-map.md`
- `web/src/routes/{home,board,me,profile}.tsx`、`web/src/lib/api/forum.ts`、`web/src/routes/_parts/mappers.ts`
- `web/scripts/check-bundle.ts`、`web/scripts/check-size.ts`（**超限时才碰**）
- `完全重构/开发必读.md`、本文件
- **不碰**：`web/src/app/**`、`web/vite*.config.ts`、`web/package.json`
- 越界但**交接单点名**：`web/src/routes/_parts/state.tsx`（I3 要把它与 14-home/states.tsx 收一份）、
  `web/src/devroom/pages/14-home/index.tsx`（I2 的第三份 GRID）、`web/src/devroom/pages/12-topic/topic.tsx`（I5 要删它那处局部类型）、
  `web/src/devroom/registry.ts`（I1 的欠账备注、I4 的登记，改的是备注/登记文字本身）。

## 步骤

- [x] 第 0 步：F1 核实「生产构建里真的没有 DevRoom 入口」—— **0 命中，不需要修**
  - 做了什么：不带 `VITE_DEVROOM` 跑一次 `pnpm build`，用一次性扫描器 `web/.tmp-wfi-scan.cjs`（扫描器**自带自检**：
    needles 拿去扫已知含 devroom 的 `src/ui/dev-entry.tsx`，扫不到就 exit 2 拒绝出结论）扫 `dist/`。
  - 证据：`cd web && pnpm build` → `✓ built in 1.02s`（exit 0）；`node .tmp-wfi-scan.cjs` →
    `产物文件 109 个；产品侧 109 个，其中可扫 80 个（dist/devroom/** 是 DevRoom 自己的入口，按设计跳过）` /
    `自检：src/ui/dev-entry.tsx 命中 2/3 ["devroom","开发页面"]` /
    `产品产物里的 devroom 命中总数：0（期望 0）` → exit 0。
    三个 needle：`devroom`、`开发页面`（入口文案）、`开发者房间`。`dist/index.html` 里只有
    `assets/index-*.js` 与若干 modulepreload，**没有** `devroom` 链接。
  - 下一步：F3 把这套扫描折进 `web/scripts/check-bundle.ts`（新增 4) 段：产品侧 `.js/.html/.css/.json/.txt/.map`
    里不得出现 `devroom`/`开发页面`/`开发者房间`，跳过 `dist/devroom/**`；命中时逐处打印
    `文件+偏移+上下文`；并**先证明它会红**（`VITE_DEVROOM=1 pnpm build` 造出带 dev 入口的产物 → 必须 exit 1），再清白重建证明绿。
  - 阻塞：无

- [ ] F2 dev 里入口是否显眼可点、不遮挡内容（1440 / 390 出图）
- [ ] I1 `inline={false}` 统一收口（comment-actions / markdown-editor / image-uploader / notice-settings + 11-profile 的「关注/发私信」）
- [ ] I2 `GRID` 三处收一处（routes/home.tsx、routes/board.tsx、devroom/pages/14-home/index.tsx）
- [ ] I3 `Empty`（routes/_parts/state.tsx）与 `EmptyState`（14-home/states.tsx）收一份
- [ ] I4 `CompactTopicRow` 未登记 → 统一到 `@/ui/topic/topic-row` 或正式登记（二选一并说明）
- [ ] I5 `lib/api/forum.ts` 的 `Topic` 改用 DTO 真名，删 `mappers.ts` / `topic.tsx` 两处局部类型 + `as`
- [ ] I7 `mappers.ts` 过期注释（说缺 excerpt）
- [ ] I8 `15-admin/admin-map.md` 说 AI 审核「不做」但代码挂着 ai 屏 → 改成实话
- [ ] B7 `me.tsx` 换不换 `IconTabs`：1440/390 两张图后定，不换就把理由写进 `设计对齐.md`
