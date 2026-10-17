// 把详情里的 content_md 变成 MarkdownEditor 能吃的 EditorState JSON。
//
// **为什么需要这一层**：MarkdownEditor 的 InitialState 对坏 JSON 是**直接抛**的（它的注释写着
// 「保存的是我们自己的格式，不该出现坏数据」），而后端 content_md 这一列还有**不是 JSON 的历史值** ——
// 老站存的是 Markdown 正文，迁移过来是纯文本。不换算就灌进编辑器，用户看到的是**空白的编辑栏**
// （2026-10-15 实测：编辑帖子进去正文全空，标题/分区/来源都对）。
//
// 规则只有两条：本来就是 EditorState 就原样用；否则把整段文本**保住**、包成一个最小文档。
// shortcut: 纯文本按段落折行（行内格式认不出来，能认的是真源那份 JSON）——
//   等历史值都编辑过一遍之后，这一支可以直接删。
export function toEditorState(value: string): string {
  if (value.trim() === '') return '';
  try {
    const parsed = JSON.parse(value) as { root?: unknown };
    if (parsed && typeof parsed === 'object' && parsed.root) return value;
  } catch {
    // 不是 JSON：往下走，当成纯文本处理
  }
  return JSON.stringify({ root: { children: paragraphs(value), direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } });
}

function paragraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter((p) => p !== '')
    .map((p) => ({
      children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: p, type: 'text', version: 1 }],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'paragraph',
      version: 1,
    }));
}
