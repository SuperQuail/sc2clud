import { useEffect, useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import DOMPurify from 'dompurify';

// 评论/正文的只读渲染。真源是 **Lexical EditorState JSON**，写入时同时生成 HTML
// （`$generateHtmlFromNodes`），这里渲染那份 HTML。渲染前再清洗一次：
// 服务端会用 bluemonday 清洗（见后端方案 §9），前端这层是纵深防御。
// 超长时按 B 站做法折叠：**渐隐 + 展开/收起**（不是截断，也不是省略号）。
export function CommentBody({
  body,
  className,
  collapsible = false,
  collapsedHeight = 220,
}: {
  body: string;
  className?: string;
  /** 超过 collapsedHeight 就折叠 */
  collapsible?: boolean;
  collapsedHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const content = useRef<HTMLDivElement>(null);

  // 只有真的超高才显示按钮：不然短评论下面会挂一个没用的「展开」
  useEffect(() => {
    const el = content.current;
    if (!el || !collapsible) return;
    setOverflowing(el.scrollHeight > collapsedHeight + 24);
  }, [body, collapsible, collapsedHeight]);

  const collapsed = collapsible && overflowing && !expanded;

  return (
    <div className='flex w-full flex-col items-start gap-1'>
      <div
        ref={content}
        className={className}
        style={
          collapsed
            ? {
                maxHeight: collapsedHeight,
                overflow: 'hidden',
                maskImage: 'linear-gradient(to bottom, black 55%, transparent)',
              }
            : undefined
        }
        // eslint-disable-next-line react/no-danger -- 已经过 DOMPurify 清洗
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body) }}
      />
      {collapsible && overflowing ? (
        // 靠右下角（用户要求）：与楼层动作行同一条右边线
        <span className='flex w-full justify-end'>
          <Button ghost onClick={() => setExpanded((v) => !v)}>{expanded ? '收起' : '展开'}</Button>
        </span>
      ) : null}
    </div>
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
