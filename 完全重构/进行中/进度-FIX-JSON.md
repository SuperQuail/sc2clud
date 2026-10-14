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
