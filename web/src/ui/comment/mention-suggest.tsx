import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { cn } from '@/lib/utils';
import type { MentionCandidate } from './mention-types';

// 输入 @ 之后自动弹出的候选面板。
// **位置由光标决定**（不是挂在编辑器下方）：调用方传 anchor（@ 符号的视口坐标），
//   面板出现在**那一行的上方**，左边缘与 **@ 符号**对齐；空间不够时才落到下方。
// 之前用 absolute top-full 挂在容器上，编辑器一高它就跑到页面角落去了。
export type Anchor = { left: number; top: number; bottom: number };

export function MentionSuggest({
  candidates,
  activeIndex,
  onPick,
  anchor,
}: {
  candidates: MentionCandidate[];
  activeIndex: number;
  onPick: (c: MentionCandidate) => void;
  /** @ 符号的视口矩形；不传就退回默认定位 */
  anchor?: Anchor | null;
}) {
  if (candidates.length === 0) return null;

  // 默认**永远在上方**（用户明确要求）；只有上方真的放不下时才翻到下面
  const above = anchor ? anchor.top > 160 : true;
  const style = anchor
    ? above
      ? { left: anchor.left, bottom: window.innerHeight - anchor.top + 4 }
      : { left: anchor.left, top: anchor.bottom + 4 }
    : undefined;

  return (
    <div
      role='listbox'
      aria-label='提及候选'
      style={style}
      className={cn(
        'z-50 flex max-h-64 w-72 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-[12px] shadow-lg',
        anchor ? 'fixed' : 'absolute left-0 top-full mt-1',
      )}
    >
      {candidates.map((c, i) => (
        <button
          key={c.id}
          type='button'
          role='option'
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault(); // 别让编辑区失焦
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
        </button>
      ))}
    </div>
  );
}
