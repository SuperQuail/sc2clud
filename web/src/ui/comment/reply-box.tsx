import { useEffect, useId, useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { UserAvatar } from '@/ui/user/avatar';

// 评论编辑器（顶层评论框与就地回复共用）。
// **不用 Ring UI 的 Input**：它是表单小输入，评论是长文本——这里用原生 textarea 自己控制尺寸
// （默认 7 行高、随输入自动长高）。src/ui 允许写原生表单元素，业务代码不许（gate:ui 会挡）。
// 需求依据：后端 §9 用户提交 Markdown 由服务端渲染（所以不需要在界面上标注）；
// 回复不带图片（图片只有头像/帖子配图/收款码三个端点），所以工具栏不放图片按钮。
const MIN_ROWS = 7;

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
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const empty = body.trim().length === 0;

  // 随输入长高（只增不减到最小值为止，避免删字时抖动）
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, 0) + 'px';
  }, [body]);

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
        <label htmlFor={id} className='sr-only'>
          评论内容
        </label>
        <textarea
          ref={area}
          id={id}
          rows={MIN_ROWS}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? id + '-err' : undefined}
          className='w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40'
        />
        <div className='flex items-center gap-3'>
          {error ? (
            <span id={id + '-err'} className='text-[12px] text-destructive'>{error}</span>
          ) : null}
          <Button primary className='ml-auto' disabled={empty} onClick={submit}>
            发布
          </Button>
        </div>
      </div>
    </div>
  );
}
