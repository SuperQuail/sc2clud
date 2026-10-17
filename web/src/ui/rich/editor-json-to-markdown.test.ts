import { expect, it } from 'vitest';
import { editorJsonToMarkdown, isEditorStateJson } from './editor-json-to-markdown';

// D6 的那一半纯函数：EditorState JSON → Markdown。
// 为什么必须有它：上行给后端的 body_md / content_md 是 **Markdown**（后端 forum 的 render 拿它过
// goldmark → bluemonday），把 EditorState JSON 直接发上去，后端只会把它当一段普通文字原样渲染 ——
// 页面上出现的就是 `{"root":{...}}`。这份测试钉住「上行之前一定换成 Markdown」。
function doc(children: unknown[]): string {
  return JSON.stringify({ root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } });
}
function text(value: string, format = 0): unknown {
  return { detail: 0, format, mode: 'normal', style: '', text: value, type: 'text', version: 1 };
}
function paragraph(children: unknown[]): unknown {
  return { children, direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1 };
}

it('段落：一段一行，段与段之间空一行；不是 JSON 的输入原样返回', () => {
  expect(editorJsonToMarkdown(doc([paragraph([text('走到第二波就卡关。')])]))).toBe('走到第二波就卡关。');
  expect(editorJsonToMarkdown(doc([paragraph([text('第一段。')]), paragraph([text('第二段。')])]))).toBe(
    '第一段。\n\n第二段。',
  );
  // 老站迁过来的正文就是 Markdown：一个字符都不许动（丢了等于把用户的正文吃掉）
  expect(editorJsonToMarkdown('第一段。\n\n第二段。')).toBe('第一段。\n\n第二段。');
  expect(editorJsonToMarkdown('')).toBe('');
});

it('行内格式：粗体 / 斜体 / 行内代码按 Lexical 的 format 位图还原', () => {
  // format 位：1 粗体、2 斜体、4 删除线、8 行内代码（lexical 的 IS_BOLD 等常量）
  expect(editorJsonToMarkdown(doc([paragraph([text('重点', 1)])]))).toBe('**重点**');
  expect(editorJsonToMarkdown(doc([paragraph([text('重点', 2)])]))).toBe('*重点*');
  expect(editorJsonToMarkdown(doc([paragraph([text('重点', 8)])]))).toBe('`重点`');
  // 粗 + 斜：两个记号都在（顺序是内层粗体、外层斜体）
  expect(editorJsonToMarkdown(doc([paragraph([text('重点', 3)])]))).toBe('***重点***');
});

it('列表与引用：无序/有序各自成形，引用每行带 >', () => {
  const item = (value: string): unknown => ({ children: [text(value)], direction: 'ltr', format: '', indent: 0, type: 'listitem', version: 1 });
  expect(
    editorJsonToMarkdown(doc([{ children: [item('第一项'), item('第二项')], direction: 'ltr', format: '', indent: 0, listType: 'bullet', start: 1, tag: 'ul', type: 'list', version: 1 }])),
  ).toBe('- 第一项\n- 第二项');
  expect(
    editorJsonToMarkdown(doc([{ children: [item('甲'), item('乙')], direction: 'ltr', format: '', indent: 0, listType: 1, start: 1, tag: 'ol', type: 'list', version: 1 }])),
  ).toBe('1. 甲\n2. 乙');
  expect(
    editorJsonToMarkdown(doc([{ children: [text('引用一句。')], direction: 'ltr', format: '', indent: 0, type: 'quote', version: 1 }])),
  ).toBe('> 引用一句。');
});

it('标题层级认 tag（元素节点的 format 恒为空串，认它会把 ## 压成 #）', () => {
  const heading = (tag: string, value: string): unknown => ({
    children: [text(value)],
    tag,
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'heading',
    version: 1,
  });
  expect(editorJsonToMarkdown(doc([heading('h2', '副标题')]))).toBe('## 副标题');
  expect(editorJsonToMarkdown(doc([heading('h1', '主标题')]))).toBe('# 主标题');
  // 旧版导出的数字口径（format 里放 # 的个数）仍然照旧
  expect(editorJsonToMarkdown(doc([{ ...(heading('h1', '旧口径') as object), tag: undefined, format: '3' }]))).toBe('### 旧口径');
});

// 「是不是编辑器状态」这条判据上下行两侧共用（上行决定换不换、回填决定怎么进编辑器），
// 所以它自己是**可证的**：'[]' / '{}' / '123' 都能 JSON.parse，但它们不是编辑器状态。
it('isEditorStateJson：只有顶层带 root 的才算编辑器状态', () => {
  expect(isEditorStateJson(doc([paragraph([text('正文')])]))).toBe(true);
  expect(isEditorStateJson('第一段。')).toBe(false);
  expect(isEditorStateJson('')).toBe(false);
  expect(isEditorStateJson('[]')).toBe(false);
  expect(isEditorStateJson('{}')).toBe(false);
  expect(isEditorStateJson('123')).toBe(false);
});

it('上行的那一份里不许再出现 JSON 的形状（root / version 这些键）', () => {
  const md = editorJsonToMarkdown(doc([paragraph([text('正文')])]));
  expect(md).not.toContain('root');
  expect(md).not.toContain('version');
});
