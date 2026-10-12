import { useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size as InputSize } from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { UserAvatar } from '@/ui/user/avatar';
import { MentionSuggest } from './mention-suggest';
import type { MentionCandidate } from './mention-types';

// 评论编辑器：**Ring UI 的 Input**（multiline + autogrow + size=FULL 撑满宽度），
// 默认三行高（min-h-20 ≈ 3 行），输入长了自动长高。
// @提及：**打 @ 自动弹候选**（照 B 站），方向键上下 + Enter 选中 + Esc 关掉。
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
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement | null>(null);

  const empty = body.trim().length === 0;
  const matched =
    query === null
      ? []
      : candidates.filter(
          (c) =>
            c.nickname.toLowerCase().includes(query.toLowerCase()) ||
            c.handle.toLowerCase().includes(query.toLowerCase()),
        );

  /** 取光标前最后一个 @ 之后的内容作为查询词；没有 @ 就返回 null */
  function readQuery(value: string, caret: number): string | null {
    const before = value.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    return m ? m[1]! : null;
  }

  function pick(c: MentionCandidate) {
    const el = area.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@([^\s@]*)$/, '');
    const after = body.slice(caret);
    const token = '@{' + c.id + '|' + c.nickname + '} ';
    setBody(before + token + after);
    setQuery(null);
    setActive(0);
    el?.focus();
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setBody(v);
    const q = readQuery(v, e.target.selectionStart ?? v.length);
    setQuery(q);
    setActive(0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (query === null) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(matched.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && matched[active]) {
      e.preventDefault();
      pick(matched[active]!);
    } else if (e.key === 'Escape') {
      setQuery(null);
    }
  }

  function submit() {
    if (empty) {
      setError('还没写内容');
      return;
    }
    setError(null);
    onSubmit?.(body.trim());
    setBody('');
    setQuery(null);
  }

  return (
    <div className='flex items-start gap-3'>
      <UserAvatar name={me.nickname} src={me.avatar} size='md' className='mt-1' />
      <div className='relative flex min-w-0 flex-1 flex-col gap-2'>
        {replyingTo ? <span className='text-[12px] text-muted-foreground'>回复 @{replyingTo}</span> : null}
        <Input
          multiline
          autogrow
          size={InputSize.FULL}
          height={ControlsHeight.L}
          value={body}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          error={error ?? undefined}
          inputRef={area}
          inputClassName='min-h-20 w-full resize-y leading-relaxed'
        />
        {query !== null ? (
          <MentionSuggest candidates={matched} activeIndex={active} onPick={pick} />
        ) : null}
        {/* 发送放在右下角（照 B 站）：ml-auto 必须加在外层 span 上——
            Ring 的 Button 不会把 className 用到外层布局上，直接传 ml-auto 不生效。 */}
        <div className='flex items-center gap-3'>
          <span className='text-[11px] text-muted-foreground'>输入 @ 提及某人</span>
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
