// @提及的两种形态互转。契约见 完全重构/论坛后端技术方案-v2.md §9。
//   存储：`@{<user_id>|<写入时昵称>}`   ← 后端真源，user_id 唯一
//   编辑：`<span data-mention="<id>" contenteditable="false">@<昵称></span>` ← 编辑框里渲染成芯片
// 编辑框必须显示渲染后的样子（不能让人看见 `@{123|唐天}` 这种原文），所以两者必须能来回转。
const TOKEN = /@\{(\d+)\|([^}]+)\}/g;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 存储格式 → 编辑用 HTML（提及变成不可编辑的芯片） */
export function storageToHtml(storage: string): string {
  return escapeHtml(storage).replace(
    /@\{(\d+)\|([^}]+)\}/g,
    (_m, id: string, nickname: string) =>
      '<span data-mention="' + id + '" contenteditable="false" class="mention-chip">@' + nickname + '</span>',
  );
}

/** 编辑用 HTML → 存储格式（芯片还原成 token；其余标签一律丢掉，正文只存纯文本 + 提及） */
export function htmlToStorage(html: string): string {
  const withTokens = html.replace(
    /<span[^>]*data-mention="(\d+)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, id: string, inner: string) => {
      const nickname = inner.replace(/^@/, '').replace(/<[^>]+>/g, '');
      return '@{' + id + '|' + nickname + '}';
    },
  );
  return withTokens
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n');
}

export function hasToken(s: string): boolean {
  TOKEN.lastIndex = 0;
  return TOKEN.test(s);
}
