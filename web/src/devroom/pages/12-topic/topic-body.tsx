import { Markdown } from '@/ui/markdown';

// 帖子正文的展示位。渲染统一走 **src/ui/markdown.tsx**（全站唯一渲染 content_html 的地方，
// 见前端方案 §7.5 / §13.2 禁止第 7 条）；这里只负责正文的排版参数（prose + 行高）。
// 评论用的 CommentBody 也复用它，所以「正文」与「评论」不会再出现两套清洗/两套样式。
export function TopicBody({ contentHtml, className }: { contentHtml: string; className?: string }) {
  return <Markdown html={contentHtml} className={'prose prose-sm max-w-none leading-[1.85] text-foreground ' + (className ?? '')} />;
}
