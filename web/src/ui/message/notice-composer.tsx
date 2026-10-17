import Button from '@jetbrains/ring-ui-built/components/button/button';
import { useState, type ReactNode } from 'react';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';
import { textLength } from '@/ui/comment/comment-body';
import type { MentionCandidate } from '@/ui/comment/mention-types';

// 输入区（私信、回复通知都用它）。正文区复用我们的 MarkdownEditor（compact 形态），
// 所以字数上限、@提及、Markdown 都与评论区一致——**不为消息中心另写一个输入框**。
export function NoticeComposer({
  placeholder = '请输入消息内容',
  maxLength = 500,
  me,
  candidates,
  toolSlot,
  onSubmit,
}: {
  placeholder?: string;
  maxLength?: number;
  me: { nickname: string; avatar?: string | null };
  candidates?: MentionCandidate[];
  /** 左下角的额外按钮（图片、表情…由使用方决定） */
  toolSlot?: ReactNode;
  onSubmit?: (payload: { json: string; html: string }) => void;
}) {
  const [body, setBody] = useState({ json: '', html: '' });
  const [length, setLength] = useState(0);
  const empty = textLength(body.html) === 0;
  return (
    <div className='flex flex-col gap-2 border-t border-border p-4'>
      <MarkdownEditor
        compact
        value={body.json}
        onChange={(json, html) => setBody({ json, html })}
        placeholder={placeholder}
        candidates={candidates}
        maxLength={maxLength}
        onLengthChange={setLength}
      />
      <div className='flex items-center gap-3'>
        {toolSlot}
        <span className='ml-auto text-[12px] tabular-nums text-muted-foreground'>
          {length} / {maxLength}
        </span>
        <Button
          data-testid='notice-send'
          primary
          disabled={empty}
          onClick={() => {
            onSubmit?.(body);
            setBody({ json: '', html: '' });
          }}
        >
          发送
        </Button>
      </div>
      <span className='sr-only'>发送者：{me.nickname}</span>
    </div>
  );
}
