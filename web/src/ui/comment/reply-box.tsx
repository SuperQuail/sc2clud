import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size as InputSize } from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { UserAvatar } from '@/ui/user/avatar';
import { MentionPicker, type MentionCandidate } from './mention-picker';

// 评论编辑器。**用 Ring UI 的 Input**：multiline + autogrow + height=L，
// 再用它官方的 `inputClassName` 给内层 textarea 一个最小高度——
// 这样框够大、又完全在库的 API 之内（之前换成原生 textarea 是走极端，丑）。
export function ReplyBox({
  me,
  replyingTo,
  candidates = [],
  placeholder = '你渴望拥有力量吗？评论让力量更强大',
  onSubmit,
}: {
  me: { nickname: string; avatar?: string | null };
  replyingTo?: string | null;
  /** @ 提及候选（真实实现来自 GET /users/search?q=） */
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
      <div className='flex min-w-0 flex-1 flex-col gap-2'>
        {replyingTo ? <span className='text-[12px] text-muted-foreground'>回复 @{replyingTo}</span> : null}
        <Input
          multiline
          autogrow
          size={InputSize.FULL}
          height={ControlsHeight.L}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          error={error ?? undefined}
          inputClassName='min-h-32 w-full resize-y leading-relaxed'
        />
        <div className='flex items-center gap-3'>
          {candidates.length > 0 ? (
            <MentionPicker
              candidates={candidates}
              onPick={(c) => setBody((v) => v + (v && !v.endsWith(' ') ? ' ' : '') + '@{' + c.id + '|' + c.nickname + '} ')}
            />
          ) : null}
          <Button primary className='ml-auto' disabled={empty} onClick={submit}>
            发布
          </Button>
        </div>
      </div>
    </div>
  );
}
