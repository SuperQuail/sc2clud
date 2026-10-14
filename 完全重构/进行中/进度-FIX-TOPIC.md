# 进度 · FIX-TOPIC（D4/D5/D6/D7/D8/D9）

> 作用域：`web/src/devroom/pages/12-topic/**`、`web/src/devroom/pages/13-issue/**`、
> `web/src/routes/{topic,issues}.tsx`、`web/src/lib/api/issues.ts`、
> `forum/internal/forum/{dto,map,issues}.go`（只在需要补字段时）、本文件。

- [x] D4：下载来源移到正文上方 + 收成紧凑一行 + `target=_blank rel=noopener`
  - 证据：`npx vitest run src/devroom/pages/12-topic/topic-view.test.tsx`
    · 旧代码（`git stash` 掉三份 View 改动后）`FAIL … D4` →
    `AssertionError: expected +0 to be truthy`（`heading.compareDocumentPosition(body) & FOLLOWING`：
    来源标题排在正文**之后**，正是缺陷本身）；改完 `Tests 11 passed (11)`。
    · 图：`shots/fix-topic/d4-12-topic-900.png`（来源块在标题下、正文之上，一行一条）。
  - 下一步：无。
  - 阻塞：无

- [x] D8：作者名与头像可点进 `/u/<handle>`（正文头部作者行 + 右栏作者卡）
  - 证据：`topic-view.test.tsx` 的 `D8` 用例（href=/u/demo-admin 且文字含「示范管理员」的链接 ≥2 条）。
  - 下一步：无。
  - 阻塞：无

- [x] D5：点「问题反馈」页签真的切过去（选中态写在 URL 上，两页共用一套 key）
  - 证据：`npx vitest run src/routes/issues.tabs.test.tsx`（2 passed）+ `topic-view.test.tsx`（11 passed）：
    页签 `aria-current=page` 来自 `?view=`；点「帖子内容」真的把人送到 `/t/:topicId`；
    View 的 `onOpenIssue` 真的被叫到；宿主不接时页签自己也会选中。
  - 下一步：无。
  - 阻塞：无

- [x] D6：正文不再显示 Lexical JSON —— **选「前端把 EditorState JSON 换成 Markdown 再上行」**
  - 证据：`npx vitest run src/routes/issues.new-issue.test.tsx`（3 passed）。
    网络替身**照后端行为写**（存下什么就渲染什么，旧测试拿手写 HTML 当 body_html 所以一直看不出）：
    `expect(posted.body.body_md).toBe('走到第二波就卡关。')`、`expect(JSON.stringify(posted.body)).not.toContain('"root"')`、
    页面上 `screen.getByText('走到第二波就卡关。')` 且 `document.body.textContent` 不含 `"root"`。
    序列化本身另有 `src/ui/rich/editor-json-to-markdown.test.ts`（4 passed：段落/格式/列表/引用 + 非 JSON 原样返回）。
  - 为什么选前端换：正文那一列**同时装两种东西**（新写的 EditorState JSON 与老站迁来的 Markdown），
    后端要认就得同时做 JSON 解析器 + Markdown 渲染器两套，而**存进去的那一份仍然不是 Markdown**
    （编辑回填、列表、迁移全都要跟着分叉）；后端契约本来就是「上行 Markdown，下行 *_html」，
    前端一次性转掉，后端一行不用动（也就不用碰 handler.go）。
  - 下一步：`routes/compose.tsx`、`routes/topic.tsx` 的正文/回复/编辑三处**也是同一根因**（上行 content_md = JSON，
    后端当 Markdown 渲染），按同一办法接 `editorJsonToMarkdown`（拍照官：它们不在本包作用域，只做记录）。
  - 阻塞：无

- [x] D7：新建反馈从弹窗改成 issue 页内的完整表单区
  - 证据：`issues.new-issue.test.tsx` 的 `D7：新建反馈是页内表单区而不是弹窗，校验逐条保留`：
    `screen.queryByRole('dialog')` 为 null、`[data-testid=new-issue-form]` 在、标题 ≥4 字与正文非空各拦一次且
    **一个 POST 都不发**、点「收起」那块区域真的消失；房间页（13-issue）与真站渲染的是同一个 `NewIssuePanel`。
  - 下一步：无（房间出图见 `shots/fix-topic/d7-13-issue.png`）。
  - 阻塞：无
