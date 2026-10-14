# 进度 · FIX-TOPIC（D4/D5/D6/D7/D8/D9）

> 作用域：`web/src/devroom/pages/12-topic/**`、`web/src/devroom/pages/13-issue/**`、
> `web/src/routes/{topic,issues}.tsx`、`web/src/lib/api/issues.ts`、
> `forum/internal/forum/{dto,map,issues}.go`（只在需要补字段时）、本文件。

- [x] D4：下载来源移到正文上方 + 收成紧凑一行 + `target=_blank rel=noopener`
  - 证据：`npx vitest run src/devroom/pages/12-topic/topic-view.test.tsx`
    · 旧代码（`git stash` 掉三份 View 改动后）`FAIL … D4` →
    `AssertionError: expected +0 to be truthy`（`heading.compareDocumentPosition(body) & FOLLOWING`：
    来源标题排在正文**之后**，正是缺陷本身）
    · 改完 `Tests 11 passed (11)`。
    · 改的是 View：`resource-sources.tsx` 从「116px 宽的圆形 logo 阵列」改成一行
    （图标+站点名+来源名+提取码+维护状态），`main-column.tsx` 把来源块排到 `<TopicBody>` 之前。
  - 下一步：无（已出图 `shots/fix-topic/d4-12-topic-900.png`，来源块在标题下、正文之上）。
  - 阻塞：无

- [x] D8：作者名与头像可点进 `/u/<handle>`（正文头部作者行 + 右栏作者卡）
  - 证据：`topic-view.test.tsx` 的 `D8：正文头部与右栏作者卡的头像/昵称都点得进 /u/<handle>`，
    `Tests 11 passed (11)`（href=/u/demo-admin 且文字含「示范管理员」的链接 ≥2 条：正文头部 + 右栏）。
  - 下一步：无。
  - 阻塞：无

- [x] D5：点「问题反馈」页签真的切过去（选中态写在 URL 上，两页共用一套 key）
  - 证据：`npx vitest run src/routes/issues.tabs.test.tsx`（2 passed）+ `topic-view.test.tsx`（11 passed）：
    · 页签选中态来自 `?view=`：`aria-current=page` 落在「问题反馈」那一格；
    · 点「帖子内容」真的把人送到 `/t/:topicId`（页面里出现帖子页的替身，不是「回调被调用过」）；
    · View 侧 `onOpenIssue` 真的被叫到；宿主不接时页签自己也会选中（不许静默）。
    · `routes/topic.tsx` 的 `onOpenIssue` 现在是一次真导航：`appPath('issues?topic=' + id)`。
  - 下一步：无。
  - 阻塞：无

- [x] D6（第一半：上行的那一份变成真 Markdown）：`editorJsonToMarkdown` + 单测
  - 证据：`npx vitest run src/ui/rich/editor-json-to-markdown.test.ts` → `4 passed`：段落/行内格式/
    列表/引用各自成形，**不是 JSON 的输入原样返回**（老站迁来的 Markdown 一个字符都不动）。
  - 下一步：把这份 Markdown 接到新建反馈的上行请求（`new-issue-form.tsx` 的提交走它），
    并在 `routes/issues.tsx` 加那条「页面正文不含 "root"」的断言。
  - 阻塞：无
