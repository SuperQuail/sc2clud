import DOMPurify from 'dompurify';

// 评论/正文的只读渲染。真源是 **Lexical EditorState JSON**，写入时同时生成 HTML
// （`$generateHtmlFromNodes`），这里渲染那份 HTML。渲染前再清洗一次：
// 服务端会用 bluemonday 清洗（见后端方案 §9），前端这层是纵深防御。
export function CommentBody({ body, className }: { body: string; className?: string }) {
  return (
    <div
      className={className}
      // eslint-disable-next-line react/no-danger -- 已经过 DOMPurify 清洗
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body) }}
    />
  );
}

/** 从生成的 HTML 里数可见字数（用于字数上限与计数显示） */
export function textLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim().length;
}
