import DOMPurify from 'dompurify';

// **全站唯一渲染后端 content_html 的地方**（前端方案 §7.5 / §13.2 禁止第 7 条）。
// 输入永远是后端已经用 bluemonday 清洗过的 HTML；这里的 DOMPurify 是纵深防御（前端方案 §7.5 明确保留这一层）。
// 为什么收成一个件：正文、评论、Issue 正文、私信气泡都要渲染同一份 HTML。
// 各写一份的结果已经在旧站上演过——两套渲染器，样式与清洗规则各自漂移（旧站根因 2）。
export function Markdown({ html, className }: { html: string; className?: string }) {
  return (
    <div
      data-testid='markdown'
      className={className}
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
    />
  );
}
