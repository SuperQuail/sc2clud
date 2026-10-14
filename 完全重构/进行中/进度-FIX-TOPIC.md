# 进度 · FIX-TOPIC（D4/D5/D6/D7/D8/D9）

> 作用域：`web/src/devroom/pages/12-topic/**`、`web/src/devroom/pages/13-issue/**`、
> `web/src/routes/{topic,issues}.tsx`、`web/src/lib/api/issues.ts`、
> `forum/internal/forum/{dto,map,issues}.go`（只在需要补字段时）、本文件。

- [x] D4：下载来源移到正文上方 + 收成紧凑一行 + `target=_blank rel=noopener`
  - 证据：`npx vitest run src/devroom/pages/12-topic/topic-view.test.tsx`
    · 旧代码（git stash 掉三份 View 改动后）`FAIL … D4` →
    `AssertionError: expected +0 to be truthy`（`heading.compareDocumentPosition(body) & FOLLOWING`：
    来源标题排在正文**之后**，正是缺陷本身）
    · 改完 `Tests 9 passed (9)`。
    · 改的是 View：`resource-sources.tsx` 从「116px 宽的圆形 logo 阵列」改成一行
    （图标+站点名+来源名+提取码+维护状态），`main-column.tsx` 把来源块排到 `<TopicBody>` 之前。
  - 下一步：D5 —— `topic-view.tsx` 的页签回调由宿主接导航（`routes/topic.tsx` 传
    `onOpenIssue={() => navigate(appPath('issues?topic=' + id))}`），`routes/issues.tsx` 的
    `TopicTaskTabs` 改成受控（`value` 由 URL 的 `?view=` 决定），并加断言「点页签后 URL 变了」。
  - 阻塞：无

- [x] D8：作者名与头像可点进 `/u/<handle>`（正文头部作者行 + 右栏作者卡）
  - 证据：同一次 `topic-view.test.tsx`，新用例 `D8：正文头部与右栏作者卡的头像/昵称都点得进 /u/<handle>`
    `Tests 9 passed (9)`（`/u/demo-admin` 且文字含「示范管理员」的链接 ≥2 条）。
  - 下一步：`topic-view.test.tsx` 里补一条「点作者卡的链接 = 宿主给的 authorHref」（已由同一查询覆盖）。
  - 阻塞：无
