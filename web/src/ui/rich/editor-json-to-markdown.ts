// EditorState JSON → Markdown（Lexical 编辑器的**上行格式**转换）。
//
// 与编辑器组件分开放的两个理由：
//  ① 业务侧要用它（新建反馈 / 发帖 / 编辑正文 / 回复），而它只是两个纯函数 —— 为它把 Lexical
//     整包（约 100KB gzip）拖进首屏是不划算的；routes 只 import 这个文件。
//  ② ui/rich/markdown-editor.tsx 本身就贴着 gate:size 的 500 行上限。
//
// **为什么必须换**：存进后端的 content_md / body_md 是 **Markdown**（后端 forum 的 render 拿它过
// goldmark → bluemonday → content_html/body_html，dto.go 只回 *_html 那一列）。把 EditorState JSON
// 直接当 Markdown 发上去，后端只会把它当一段普通文字：goldmark 转义引号、包一层 <p>，
// 于是页面上出现的就是 `{"root":{...}}`（D6 就是这么来的）。所以上行之前必须换成 Markdown。
//
// 为什么不是在后端认 JSON：正文这一列**同时装两种东西** —— 新写的（要一起认 root/paragraph/…
// 一套节点）与老站迁过来的 Markdown 原文（老站的 content_md 就是 Markdown），
// 后端要认就得同时做「JSON 解析器 + Markdown 渲染器」两套，而**存进去的那一份仍然不是 Markdown**
// （列表、编辑回填、老站迁移全都要跟着分叉）。前端在这里一次性转掉，后端一行不用动。
//
// 单位是**块**：段与段之间空一行，行内格式用 Markdown 记号。未登记的节点（图片/提及）退化成它自己的
// 可读文字，**不丢内容**——图片的 URL 就是它的文字，提及是 @昵称。
// ---- EditorState JSON → Markdown ----
// **为什么需要它**：存进后端的 content_md / body_md 是 **Markdown**（后端 forum 的 render 拿它过
// goldmark → bluemonday → content_html/body_html，dto.go 只回 *_html 那一列）。把 EditorState JSON
// 直接当 Markdown 发上去，后端只会把它当一段普通文字：goldmark 转义引号、包一层 <p>，
// 于是页面上出现的就是 \`{"root":{...}}\`（D6 就是这么来的）。所以上行之前必须换成 Markdown。
//
// 为什么不是在后端认 JSON：正文这一列**同时装两种东西** —— 新写的（要一起认 root/paragraph/…
// 一套节点）与老站迁过来的 Markdown 原文（老站的 content_md 就是 Markdown），
// 后端要认就得同时做「JSON 解析器 + Markdown 渲染器」两套，而**存进去的那一份仍然不是 Markdown**
// （列表、编辑回填、老站迁移全都要跟着分叉）。前端在这里一次性转掉，后端一行不用动。
// 两个字段各自的用途不变：content_md 给编辑回填（无损 JSON），正文展示走上行后服务端渲染的 *_html。
//
// 单位是**块**：段与段之间空一行，行内格式用 Markdown 记号。未登记的节点（图片/提及）退化成它自己的
// 可读文字，**不丢内容**——图片的 URL 就是它的文字，提及是 @昵称。
type JsonNode = {
  type?: string;
  text?: string;
  url?: string;
  /** 文本节点是格式位图（数字），标题节点却是 `#` 的个数（字符串）—— 两个都见过，按联合收 */
  format?: number | string;
  /** 列表节点：'bullet' | 'number'（新版）或 1 | 2 | 3（旧版导出的数字口径） */
  listType?: string | number;
  children?: JsonNode[];
  /** 只有顶层那个节点有 root */
  root?: JsonNode;
};
const ORDERED = 1; // 与 Lexical 的常量同值；@lexical/list 不为它导出一个可读名字

function inlineOf(node: JsonNode): string {
  if (node.type === 'text') {
    let text = node.text ?? '';
    const format = typeof node.format === 'number' ? node.format : 0;
    // 行内代码用反引号（下面是 0x60，写 \u0060 是为了这一行本身不被编辑器的语法读成代码块边界）
    if (format & 8) text = '\u0060' + text + '\u0060';
    if (format & 4) text = '~~' + text + '~~';
    if (format & 2) text = '*' + text + '*';
    if (format & 1) text = '**' + text + '**';
    return text;
  }
  if (node.type === 'link') return '[' + (node.children ?? []).map(inlineOf).join('') + '](' + (node.url ?? '') + ')';
  if (node.type === 'image') return '![' + (node.text ?? '') + '](' + (node.url ?? '') + ')';
  return (node.children ?? []).map(inlineOf).join('');
}

function blockOf(node: JsonNode, indent: string): string {
  if (node.type === 'list') {
    let i = 1;
    // 有序列表的编号由这里数；无序的每条一个 -
    return (node.children ?? [])
      .map((item) => {
        const marker = node.listType === ORDERED || node.listType === 'number' ? i++ + '. ' : '- ';
        return (item.children ?? []).map((child) => indent + marker + inlineOf(child)).join('\n');
      })
      .join('\n');
  }
  if (node.type === 'quote') return (node.children ?? []).map((child) => indent + '> ' + inlineOf(child)).join('\n');
  if (node.type === 'heading') return indent + '#'.repeat(Number(node.format) || 1) + ' ' + (node.children ?? []).map(inlineOf).join('');
  return indent + (node.children ?? []).map(inlineOf).join('');
}

/** EditorState JSON → Markdown。不是 JSON（老站迁来的 Markdown 原文）就**原样返回**，一个字符都不动。 */
export function editorJsonToMarkdown(state: string): string {
  let doc: JsonNode;
  try {
    doc = JSON.parse(state) as JsonNode;
  } catch {
    return state;
  }
  // 判据是「顶层有 root 节点」，不是「JSON.parse 成功」：'[]' 也能 parse，但它不是编辑器状态
  if (!doc || typeof doc !== 'object' || !doc.root) return state;
  return (doc.root.children ?? [])
    .map((child) => blockOf(child, ''))
    .filter((block) => block.trim() !== '')
    .join('\n\n');
}
