import { markdownToHtml } from '@/ui/rich/markdown';

// 评论正文渲染。**与编辑器共用同一个渲染器**（marked + DOMPurify + @提及还原成链接），
// 所以预览看到什么，发出来就是什么。存储是 Markdown（含 `@{id|昵称}` token），不是 HTML。
export function CommentBody({ body, className }: { body: string; className?: string }) {
  return (
    <div
      className={className}
      // eslint-disable-next-line react/no-danger -- 已经过 DOMPurify 清洗
      dangerouslySetInnerHTML={{ __html: markdownToHtml(body) }}
    />
  );
}
