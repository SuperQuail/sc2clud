import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MarkdownEditor } from './markdown-editor';
import { editorJsonToMarkdown } from './editor-json-to-markdown';

// **回填方向**（上行 editorJsonToMarkdown 的另一半）：后端 content_md / body_md 这一列**同时装两种东西** ——
// 我们自己存的 EditorState JSON，与老站迁来的 Markdown 原文（缺陷清单 D6）。
// 两种都必须进得了编辑器：旧版 InitialState 只认 JSON，喂它 Markdown 时 parseEditorState 抛 SyntaxError，
// React 会把整棵编辑器从页面上卸掉 —— 编辑任何一条 Markdown 正文的帖子都是白屏
// （routes/compose.tsx 的编辑态、12-topic 的编辑弹层就是这么喂的）。
const JSON_STATE = JSON.stringify({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: '走到第二波就卡关。', type: 'text', version: 1 }],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
});
const MARKDOWN = '## 余烬\n\n第一段。';

it('回填：EditorState JSON（我们自己存的）进编辑器，内容与上行那份对得上', async () => {
  const onChange = vi.fn();
  render(<MarkdownEditor value={JSON_STATE} onChange={onChange} />);
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(editorJsonToMarkdown(onChange.mock.calls[0]![0] as string)).toBe('走到第二波就卡关。');
  expect(screen.getByLabelText('正文').textContent).toContain('走到第二波就卡关。');
});

it('回填：老站迁来的 Markdown 原文也进得去（不抛、内容不丢、出来还是同一段）', async () => {
  const onChange = vi.fn();
  render(<MarkdownEditor value={MARKDOWN} onChange={onChange} />);
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  // 进来一次、出去一次不许变形：标题层级也要在（## 不是 #）
  expect(editorJsonToMarkdown(onChange.mock.calls[0]![0] as string)).toBe(MARKDOWN);
  const body = screen.getByLabelText('正文');
  expect(body.textContent).toContain('余烬');
  expect(body.textContent).toContain('第一段。');
});
