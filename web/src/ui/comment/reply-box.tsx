import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { UserAvatar } from '@/ui/user/avatar';

// 评论编辑器（顶层的评论框与就地回复共用）。
// **复用 Ring UI 的 Input**：multiline + autogrow + height=L —— 之前只用 multiline，框太小写不了长评论。
// 没有「取消」按钮：就地回复点别处即收起，顶层评论框本来就不需要取消（B 站也没有）。
export function ReplyBox({
  me,
  replyingTo,
  placeholder = '你渴望拥有力量吗？评论让力量更强大',
  onSubmit,
}: {
  me: { nickname: string; avatar?: string | null };
  replyingTo?: string | null;
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
        {replyingTo ? (
          <span className='text-[12px] text-muted-foreground'>回复 @{replyingTo}</span>
        ) : null}
        <Input
          multiline
          autogrow
          height={ControlsHeight.L}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          error={error ?? undefined}
        />
        <div className='flex items-center gap-3'>
          <span className='text-[11px] text-muted-foreground'>支持 Markdown</span>
          <Button primary className='ml-auto' disabled={empty} onClick={submit}>
            发布
          </Button>
        </div>
      </div>
    </div>
  );
}
