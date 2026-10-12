import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { UserAvatar } from '@/ui/user/avatar';
import { MarkdownEditor } from '@/ui/rich/markdown-editor';
import { textLength } from './comment-body';
import type { MentionCandidate } from './mention-types';

// 评论编辑器 = MarkdownEditor 的 compact 形态：单栏、可切预览、不带图片。
// 存储是 **Markdown**（契约见后端方案 §9），@提及在源码里是 `@{id|昵称}`，预览里渲染成可点链接。
export function ReplyBox({
  me,
  replyingTo,
  candidates = [],
  onSubmit,
  maxLength = 10000,
}: {
  me: { nickname: string; avatar?: string | null };
  replyingTo?: string | null;
  candidates?: MentionCandidate[];
  onSubmit?: (payload: { json: string; html: string }) => void;
  /** 评论字数上限，默认 10000 */
  maxLength?: number;
}) {
  const [body, setBody] = useState<{ json: string; html: string }>({ json: '', html: '' });
  const [error, setError] = useState<string | null>(null);
  const [length, setLength] = useState(0);
  const len = textLength(body.html);
  const over = length >= maxLength;

  function submit() {
    if (len === 0) {
      setError('还没写内容');
      return;
    }
    setError(null);
    onSubmit?.(body);
    setBody({ json: '', html: '' });
  }

  return (
    <div className='flex items-start gap-3'>
      <UserAvatar name={me.nickname} src={me.avatar} size='md' className='mt-1' />
      <div className='flex min-w-0 flex-1 flex-col gap-2'>
        {replyingTo ? <span className='text-[12px] text-muted-foreground'>回复 @{replyingTo}</span> : null}
        <MarkdownEditor
          compact
          value={body.json}
          onChange={(json, html) => setBody({ json, html })}
          candidates={candidates}
          maxLength={maxLength}
          onLengthChange={setLength}
        />
        {error ? <span className='text-[12px] text-destructive'>{error}</span> : null}
        <div className='flex items-center gap-3'>
          <span className='ml-auto flex items-center gap-3'>
            <span className={'text-[11px] tabular-nums ' + (over ? 'text-destructive' : 'text-muted-foreground')}>{length} / {maxLength}</span>
            <Button primary disabled={len === 0} onClick={submit}>发布</Button>
          </span>
        </div>
      </div>
    </div>
  );
}
