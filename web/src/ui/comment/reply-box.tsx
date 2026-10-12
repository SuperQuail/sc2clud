import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { UserAvatar } from '@/ui/user/avatar';
import { MentionEditor } from './mention-editor';
import type { MentionCandidate } from './mention-types';

// 评论编辑器。正文区是 MentionEditor（Ring ContentEditable 承载）——
// **@ 在编辑时就渲染成芯片**，用户不会看到 `@{123|唐天}` 这种内部格式。
// 发送按钮在右下角（照 B 站），旁边是字数；不再有「输入 @ 提及」的说明文字。
export function ReplyBox({
  me,
  replyingTo,
  candidates = [],
  placeholder = '你渴望拥有力量吗？评论让力量更强大',
  onSubmit,
}: {
  me: { nickname: string; avatar?: string | null };
  replyingTo?: string | null;
  candidates?: MentionCandidate[];
  placeholder?: string;
  onSubmit?: (body: string) => void;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const empty = body.trim().length === 0;

  function submit() {
    if (empty) {
      setError('还没写内容');
      return;
    }
    setError(null);
    onSubmit?.(body.trim());
    setBody('');
  }

  return (
    <div className='flex items-start gap-3'>
      <UserAvatar name={me.nickname} src={me.avatar} size='md' className='mt-1' />
      <div className='relative flex min-w-0 flex-1 flex-col gap-2'>
        {replyingTo ? <span className='text-[12px] text-muted-foreground'>回复 @{replyingTo}</span> : null}
        <MentionEditor value={body} onChange={setBody} candidates={candidates} placeholder={placeholder} />
        {error ? <span className='text-[12px] text-destructive'>{error}</span> : null}
        {/* 发送在右下角（照 B 站）：ml-auto 必须加在外层 span 上——Ring Button 不参与外层布局 */}
        <div className='flex items-center gap-3'>
          <span className='ml-auto flex items-center gap-3'>
            <span className='text-[11px] tabular-nums text-muted-foreground'>{body.length} / 2000</span>
            <Button primary disabled={empty} onClick={submit}>
              发布
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
