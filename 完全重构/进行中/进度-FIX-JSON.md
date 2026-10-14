# 进度 · FIX-JSON（「编辑器 JSON 当 Markdown 上行」的其余三处 + 回填方向）

> 作用域：`web/src/routes/{compose,topic,issues}.tsx`、`web/src/ui/rich/**`、
> `web/src/lib/api/**`（只加函数）、本文件。**后端一行没动**（契约就是收 Markdown）。
> 背景：FIX-TOPIC 做完 D6 后留下的三处同根因（发帖/编辑正文、回复、issue 评论）+ 回填方向。

- [x] 回填方向：`MarkdownEditor` 对「不是 EditorState JSON」的初值不再抛（改走 Markdown 导入）
  - 证据：先红 `npx vitest run src/ui/rich/markdown-editor.test.tsx` →
    `SyntaxError: Unexpected token '#'`（初值 `## 余烬` 进不去编辑器）+ `Tests 1 failed | 1 passed`；
    改完 `Tests 6 passed`（含 `editor-json-to-markdown.test.ts` 6 条）。
    判据 `isEditorStateJson`（顶层有 root）由上下行两侧共用；顺带修掉标题层级丢失
    （元素节点的 format 恒为 `''`，层级在 `tag` 上：`## 副标题` 不再被压成 `# 副标题`）。
  - 下一步：`routes/compose.tsx` 的 `submit`（createTopic / updateTopic）把 `doc.json` 过
    `editorJsonToMarkdown`；断言加在 `compose.test.tsx`，替身照后端行为写（存什么渲染什么）。
  - 阻塞：无

- [x] 发帖 / 编辑正文（`routes/compose.tsx`）：两条路共用同一行 `editorJsonToMarkdown(doc.json)`
  - 证据：先红 `npx vitest run src/routes/compose.test.tsx` →
    `AssertionError: expected '{"root":{"children":[…' to be '走到第二波就卡关。'`（发帖 POST 与编辑 PATCH 两条各红一次，
    `Tests 2 failed | 3 passed`）；改完 `Tests 5 passed`（原有 3 条不动）。
    断言：`content_md === '走到第二波就卡关。'` 且 `JSON.stringify(body)` 不含 `"root"`。
    替身照后端行为写：记下每次请求的 url/method/body（原先的 mockApi 不记，看不出上行长什么样）。
    编辑器在 jsdom 里收不到真实输入（实测 `fireEvent.input` 不产生 onChange），
    所以这一份按 D6 的办法注入假编辑器（它照真契约报 EditorState JSON + HTML）。
  - 下一步：`routes/topic.tsx` 的 `reply`（createPost）与 `save`（updateTopic）过同一个函数；
    `topic.test.tsx` 的 B6 那条现在断言 `JSON.parse(content_md)).toHaveProperty('root')`（正是缺陷本身），要翻过来。
  - 阻塞：无

- [x] 回复与编辑正文（`routes/topic.tsx`）：`reply`（createPost）与 `save`（updateTopic）各过一行同一函数
  - 证据：先红 `npx vitest run src/routes/topic.test.tsx` → `Tests 2 failed | 10 passed`：
    ① B6 那条原来断言 `JSON.parse(content_md)).toHaveProperty('root')` —— **它钉的就是缺陷本身**，
    翻成 `toBe('正文')` + 整个 body 不含 `"root"`（这条同时钉住回填：老正文「正文」原样保住）；
    ② 新增「上行（回复）」：替身照后端行为写（POST 存 content_md、列表接口回它的渲染结果），
    报红 `expected '{"root":…' to be '走到第二波就卡关。'`；改完 `12 passed`。
    · 页面里另有一条 `onResubmit` 把详情的 `content_md`（本来就是 Markdown）递给 `save` ——
    换算对非 JSON 原样放行，不会把老正文吃掉。
  - 下一步：`routes/issues.tsx` 的评论提交（`onComment` → `createIssueComment` 的 `body_md`）
    是同一根因的最后一处；断言写在网络替身上（fetch 桩 + 假编辑器）。
  - 阻塞：无

- [x] 反馈评论（`routes/issues.tsx` 的 `onComment`）：`body_md` 过 `editorJsonToMarkdown`（三处收口）
  - 证据：先红 `npx vitest run src/routes/issues.test.tsx -t '上行（反馈评论）'` →
    `AssertionError: expected '{"root":{"children":[…' to be '补充：换存档也一样。'`
    （Received 就是那段 EditorState JSON）；改完 `npx vitest run src/routes/issues*.test.tsx` = `14 passed`（3 个文件，
    含 FIX-TOPIC 的 D6/D7 那份，没有回退）。
    · 替身照后端行为写：POST 存下 `body_md`，评论区接口回的就是它的渲染结果，所以「页面里看到的是正文本身」也一并断言了。
    顺带把 fetch 桩的回调扩成 `(url, method, body)`（原先只看 url，POST 与 GET 同路径分不开）。
  - 下一步：收工验证 —— 全量 `npx vitest run` + 出图（`web/scripts/cdp-shot.ts`）。
  - 阻塞：无
