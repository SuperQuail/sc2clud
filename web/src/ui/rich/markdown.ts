import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { appPath } from '@/lib/url';

// Markdown 渲染的**唯一入口**（编辑器预览与只读展示共用）。
// 底层用 marked 解析、DOMPurify 清洗——**不自己写 HTML 拼装**（HTML 太重，也容易漏 XSS）。
// 服务端同样会渲染一遍（goldmark + bluemonday，见后端方案 §9），前端这份只用于即时预览。
marked.setOptions({ gfm: true, breaks: true });

// @提及在 Markdown 里就是普通文本 `@{id|昵称}`（见 §9 的契约）。
// 解析前换成标准链接语法，解析后再把 `mention:` 协议的 href 换成真实路径——
// 这样不用写 marked 扩展，也不会被 Markdown 的其它规则打散。
const TOKEN = /@\{(\d+)\|([^}]+)\}/g;

export function markdownToHtml(md: string): string {
  const withLinks = md.replace(TOKEN, (_m, id: string, nick: string) => '[@' + nick + '](mention:' + id + ')');
  const html = marked.parse(withLinks, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'data-mention', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/|\.\/|#|mention:)/i,
  });
  return clean.replace(/href="mention:(\d+)"/g, (_m, id: string) => 'href="' + appPath('u/' + id) + '" data-mention="' + id + '"');
}

// 纯文本长度（用于字数统计）：去掉 Markdown 记号与 token
export function plainLength(md: string): number {
  return md
    .replace(TOKEN, (_m, _id: string, nick: string) => nick)
    .replace(/[#*>`_~\[\]()!-]/g, '')
    .trim().length;
}
