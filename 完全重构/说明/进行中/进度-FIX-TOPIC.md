# 进度 · FIX-TOPIC（D4/D5/D6/D7/D8/D9）

> 作用域：`web/src/devroom/pages/12-topic/**`、`web/src/devroom/pages/13-issue/**`、
> `web/src/routes/{topic,issues}.tsx`、`web/src/lib/api/issues.ts`、
> `forum/internal/forum/{dto,map,issues}.go`（只在需要补字段时）、本文件。
> **后端一行都没改**（D6 选的是前端换格式，见下）。

- [x] D4：下载来源移到正文上方 + 收成紧凑一行 + `target=_blank rel=noopener`
  - 证据：`npx vitest run src/devroom/pages/12-topic/topic-view.test.tsx`
    · 旧代码（`git stash` 掉三份 View 改动后）`FAIL … D4` →
    `AssertionError: expected +0 to be truthy`（`heading.compareDocumentPosition(body) & FOLLOWING`：
    来源标题排在正文**之后**，正是缺陷本身）；改完 `Tests 15 passed`（topic 两组）。
    · 图：`shots/fix-topic/d9-rail.png`（来源块在标题下、正文之上，一行一条：图标+站点+来源+提取码+大小）。
  - 下一步：无。
  - 阻塞：无

- [x] D8：作者名与头像可点进 `/u/<handle>`（正文头部作者行 + 右栏作者卡）
  - 证据：`topic-view.test.tsx` 的 `D8` 用例（href=/u/demo-admin 且文字含「示范管理员」的链接 ≥2 条）。
    · 顺带修掉真站上的一处显示缺陷：作者卡的加入时间原来直接显示 RFC3339
    （`2024-03-02T00:00:00Z加入`）—— `toDesignAuthor` 现在过 `joinedMonth()`，与个人主页同一口径。
  - 图：`shots/fix-topic/product-topic.png`（产品页真实壳）。
  - 阻塞：无

- [x] D5：点「问题反馈」页签真的切过去（选中态写在 URL 上，两页共用一套 key）
  - 证据：`npx vitest run src/routes/issues.tabs.test.tsx`（2 passed）+ `topic-view.test.tsx`：
    页签 `aria-current=page` 来自 `?view=`；点「帖子内容」真的把人送到 `/t/:topicId`；
    View 的 `onOpenIssue` 真的被叫到；宿主不接时页签自己也会选中（不许静默）。
  - 下一步：无。
  - 阻塞：无

- [x] D6：正文不再显示 Lexical JSON —— **选「前端把 EditorState JSON 换成 Markdown 再上行」**
  - 证据：`npx vitest run src/routes/issues.new-issue.test.tsx`（3 passed）。网络替身**照后端行为写**
    （存下什么就渲染什么；旧测试拿手写 HTML 当 body_html，所以这个缺陷一直看不出来）：
    `expect(posted.body.body_md).toBe('走到第二波就卡关。')`、
    `expect(JSON.stringify(posted.body)).not.toContain('"root"')`、
    `expect(screen.getByText('走到第二波就卡关。'))`、`document.body.textContent` 不含 `"root"`。
    序列化本身另有 `src/ui/rich/editor-json-to-markdown.test.ts`（4 passed：段落/格式/列表/引用 + 非 JSON 原样返回）。
  - 为什么选前端换（另一条路是后端认 JSON）：正文那一列**同时装两种东西**（新写的 EditorState JSON 与
    老站迁来的 Markdown），后端要认就得同时做 JSON 解析器 + Markdown 渲染器两套，而**存进去的那一份
    仍然不是 Markdown**（编辑回填、列表、迁移全都要跟着分叉）；后端契约本来就是「上行 Markdown，
    下行 *_html」（`issues.go` 的 render → goldmark → bluemonday），前端一次性转掉，后端一行不用动。
  - 下一步：`routes/compose.tsx`（发帖 / 编辑正文）与 `routes/topic.tsx` 的回复是**同一条根因**
    （上行 content_md = EditorState JSON → 后端当 Markdown 渲染），接
    `@/ui/rich/editor-json-to-markdown` 即可；那几处不在本包作用域，只做记录。
  - 阻塞：无

- [x] D7：新建反馈从弹窗改成 issue 页内的完整表单区
  - 证据：`issues.new-issue.test.tsx` 的 `D7` 用例：`queryByRole('dialog')` 为 null、
    `[data-testid=new-issue-form]`（aria-label=我要反馈）在、标题 ≥4 字与正文非空各拦一次且
    **一个 POST 都不发**、点「收起」那块区域真的消失；房间页与真站渲染同一个 `NewIssuePanel`。
    · 编辑器按需加载（Lexical ≈100KB gzip 不进首屏），测试用 `Editor` 注入点换成假编辑器。
  - 下一步：无（房间出图 `shots/fix-topic/d7-13-issue.png`）。
  - 阻塞：无

- [x] D9：右栏「关注」与徽章不再含混 —— 先量几何，结论是**从来没有真重叠**，改的是分组与留白
  - 证据（浏览器实测，脚本 `shots/fix-topic/overlap.mjs`：把右栏所有可见控件/徽章两两比矩形）：
    1440 / 1000 / 700 三个视口**都没有任何一对相交**，唯一的「重叠」是头像链接包着自己的 img（嵌套，非缺陷）。
    实测坐标（1440）：关注按钮 y 709..733，作者卡角色徽章 y 916..936 —— 纵向差 183px，横向重叠 38px。
    即截图里那种「压住」是**同一列上下两格贴太近**造成的观感，不是叠层问题（缺陷清单里这条本来就标了「待核」）。
  - 改法：`board-summary.tsx` 的两个动作（关注 / 发帖）单独成行、上下各加分隔线；
    作者卡身份区与上一格间距 170px → 183px。图：`shots/fix-topic/d9-rail.png`。
  - 下一步：如果那张截图确实是**真重叠**，请把原图或复现步骤发回来（我这边三个视口都量不到）。
  - 阻塞：无

## 顺手收掉的（同一轮踩到、同一处改）

- `routes/topic.tsx` 546 → **411 行**、`routes/issues.tsx` 540 → **497 行**：
  DTO 映射搬到 `routes/_parts/{topic,issues}-mappers.ts`，表单搬进 `13-issue/new-issue-panel.tsx`。
  `gate:size` 里那两条登记（当初写的正是「拆出映射与版面」）按门禁规矩撤掉 —— `node scripts/check-size.ts`
  `检查 324 个文件，超限 1 个`（剩下的是别人的 `15-admin/screens/boards.tsx`，已登记）。
- B6（同一段话就在我的文件里）：`onResubmit` 原来谎称「PATCH /topics/{id} 不会重置 review_state」，
  实际带 content_md 的 PATCH 就会回 pending（`ResetTopicReview`）——现在它是**真请求**，不再只给回执。

## 收工验证

- `pnpm typecheck` 干净；`pnpm lint` `0 errors`（17 warnings，全是仓库既有的 react-refresh 类）。
- `npx vitest run`：48 个文件里 **47 绿**；唯一红的是别的包新加的
  `devroom/pages/10-messages/same-source.test.tsx`（FIX-MSG 的 D10），**单独跑绿、全量跑红**（连跑两次都红），
  与本包改动无关 —— 记在这里供 Lead 归因。
- `node scripts/check-size.ts` 通过。`pnpm check` **没跑**（协议：清 dist、与别人互踩）。
