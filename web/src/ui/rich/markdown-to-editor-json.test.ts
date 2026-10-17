import { expect, it } from 'vitest';
import { toEditorState } from './markdown-to-editor-json';

// 2026-10-15 实测的根因钉子：content_md 是历史列（老站是 Markdown 纯文本），
// 直接灌 MarkdownEditor（它按 EditorState JSON 解析）→ 编辑帖子进去正文全空。
it('EditorState JSON 原样用，纯文本包成最小文档（不抛、也不丢内容）', () => {
  const state = JSON.stringify({ root: { children: [], type: 'root', version: 1 } });
  expect(toEditorState(state)).toBe(state);

  const fromText = JSON.parse(toEditorState('第一段。\n\n第二段。')) as {
    root: { children: { children: { text: string }[] }[] };
  };
  expect(fromText.root.children).toHaveLength(2);
  expect(fromText.root.children[0]!.children[0]!.text).toBe('第一段。');
  expect(toEditorState('   ')).toBe('');
});

// 迁移来的真实 Markdown（带标题行与列表行）也必须被保住 —— 丢内容是最坏的一种。
it('Markdown 纯文本：段落数保住，文本一字不丢', () => {
  const md = '弥音启动器（SC2Miyin Launcher）—— 用 Rust 写的管理器。\n\n下载：只做索引与转链。';
  const doc = JSON.parse(toEditorState(md)) as { root: { children: { children: { text: string }[] }[] } };
  expect(doc.root.children).toHaveLength(2);
  const all = doc.root.children.map((c) => c.children[0]!.text).join('\n');
  expect(all).toContain('弥音启动器');
  expect(all).toContain('下载：只做索引与转链。');
});
