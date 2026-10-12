import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { cn } from '@/lib/utils';
import type { MentionCandidate } from './mention-types';

// 输入 @ 之后**自动弹出**的候选面板（不是按钮触发的下拉）。
// 为什么不用 DropdownPanel：它的语义是「点触发器开合」；这里是随输入出现、随选择消失，
// 而且需要方向键选择——两种交互不同，硬套会更绕。
export function MentionSuggest({
  candidates,
  activeIndex,
  onPick,
}: {
  candidates: MentionCandidate[];
  activeIndex: number;
  onPick: (c: MentionCandidate) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div
      role='listbox'
      aria-label='提及候选'
      className='absolute left-0 top-full z-50 mt-1 flex max-h-64 w-72 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-[12px] shadow-lg'
    >
      {candidates.map((c, i) => (
        <button
          key={c.id}
          type='button'
          role='option'
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault(); // 别让输入框失焦
            onPick(c);
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left outline-none transition-colors',
            i === activeIndex ? 'bg-accent' : 'hover:bg-accent',
          )}
        >
          <UserAvatar name={c.nickname} src={c.avatar} size='sm' />
          <Username nickname={c.nickname} />
          <span className='min-w-0 truncate text-[11px] text-muted-foreground'>@{c.handle}</span>
          {c.duplicate ? (
            <span className='ml-auto shrink-0 rounded-[3px] bg-muted px-1 text-[10px] text-muted-foreground'>重名</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
