# 进度 · FIX-COPY（issue 种类文案 + 用户可见处裸串）

> 作用域：`web/src/devroom/pages/12-topic/_task/**`、`web/src/devroom/pages/13-issue/**`、
> `web/src/routes/issues.tsx`、`web/src/devroom/pages/12-topic/topic-view.tsx`（只改文案相关行）、本文件。
> 依据：`10-dev排查-缺陷清单.md §1c` 第三轮拍板（用户原话「汇报 bug 按钮就是汇报 bug，而不是什么奇怪的词」）。
> **迁移号：本包不占号** —— 纯前端文案/文本，无 schema 变更（0031 起留给真要迁移的包）。

- [x] 步骤1：种类文案真源单点改「报个 Bug」→「汇报 Bug」，**所有**出现处一起改（含测试断言）
  - 证据：
    · **先证明断言会红**：只改真源 `12-topic/_task/types.ts:29`（先不动测试）→
      `npx vitest run src/devroom/pages/13-issue/index.test.tsx src/devroom/pages/12-topic/topic-view.test.tsx src/routes/issues.test.tsx src/routes/issues.new-issue.test.tsx`
      → `Test Files 4 failed (4) | Tests 5 failed | 22 passed`，5 条全部是
      `Unable to find role="button" and name /^报个 Bug/`（`topic-view.test.tsx` 那条是 `role="link"`）——
      证明这些断言**确实盯着这串文案**，不是「永远通过」的检查。
    · 改完 8 处（真源 1 + 注释/出图页 2 + 断言 4 个文件 5 处；`issue-kind-button.tsx` 的 title/aria-label
      与产品页按钮文字都从真源 `ISSUE_KIND_META` 派生，**没有第二份词表**）→ 同一命令
      `Test Files 4 passed (4) | Tests 27 passed`。
    · `pnpm typecheck` 退出码 0；`pnpm lint` → `17 problems (0 errors, 17 warnings)`（全是仓库既有 warning）。
    · 全仓 `报个 Bug` 剩余命中只有**历史记录**：`进度-W3.md` 两条旧记录、`10-dev排查-缺陷清单.md §1c`
      引用改动前原文的表格 —— 历史不改写，故保留（已逐条确认无代码/无断言残留）。
  - 下一步：步骤2 —— 裸串排查与收口：`13-issue/issue-filter-bar.tsx:127-135` 的「限定词」语法提示
    （用户截图里 `|difficulty|other·label:` 的形状就是它）、`13-issue/index.tsx:283` 与
    `routes/issues.tsx:420` 的 `状态开关（Open / Closed）` + `复用 @/ui/comment`、
    `routes/issues.tsx:337-339` 的 Markdown `**` 字面量、`routes/issues.tsx:271` 的 `forum.not_resource`。
  - 阻塞：无
