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
  - 下一步：收工验证 —— 全量 `npx vitest run` + 出图。
  - 阻塞：无

- [x] 收工验证：全量门禁 + 出图 + 浏览器里真跑一遍「编辑 → 打字 → 保存」
  - 证据：`pnpm typecheck` 0；`pnpm lint` 0 error（17 条既有 warning）；`node scripts/check-size.ts` 通过；
    `npx vitest run` = **49 files / 234 tests 全绿**（含别人那条 flake
    `devroom/pages/10-messages/same-source.test.tsx` —— 0fd3871 已把它的超时放宽到 20s，本轮全量跑绿，不是我的）。
    · 图 `shots/fix-json/`（产品预览入口 `web/product.html`，1440×900）：`1-topic-author.png`（帖子页 + 回复框）、
    `2-topic-edit.png`（编辑弹层：正文从 `content_md` 灌进编辑器）、`4-issues-comment.png`（反馈详情 + 评论框）、
    `3-issues.png`（反馈列表）。四张都看过：没有白屏、编辑器与工具栏都在、MARKER-PRODUCT 在。
    · 浏览器里真的点开编辑、键入一句、点保存，再从桩（照后端行为写：存下 `content_md`）读回上行的那一份：
    `{"title":"…","content_md":"补一句：读档后计时已改按任务时间。第三章「余烬」已经发布。…\n\n下载与提取码见右侧来源区；…"}`
    —— **Markdown，整串里没有 `"root"`**。
  - 下一步：无（三处上行 + 回填都收口；后端一行没改）。
  - 阻塞：① `web/scripts/cdp-shot.ts` 的 `Cdp.eval` 读错 CDP 回包层级（`send()` 已经包了一层
    `{result}`，eval 又读 `r.result.value`，真值在 `r.result.result.value`）→ `click:` / `type:` 永远报「点不到」。
    一行可修，文件不在本包作用域，**没动**；本轮的点击态图用自己的 `shots/fix-json/shot.mjs` 出的。
    ② 产品预览入口 `web/src/preview/product.tsx` 的路由表没有 `/new`，**发帖页出不了图**（那一处只有单测证据）；
    要出图得往那张表加一行 `{ path: 'new', lazy: … ComposePage }`，文件不在本包作用域。
    ③ 后端没有会拒绝纯 Markdown 的地方：`content_md`/`body_md` 是 text，渲染走 goldmark → bluemonday，
    长度上限按**字节**（帖子 20000 / 回复 8000，`forum/limits.go`），而 Markdown 比等价的 EditorState JSON 更短
    —— 不需要改后端。
