import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { cn } from '@/lib/utils';
import type { MentionOption } from './mention-option';

// 提及菜单的内容。**位置、滚动跟随、↑↓/Enter/Esc 全部交给 LexicalTypeaheadMenuPlugin 的默认行为**——
// 这里只画列表，并把插件给的元素引用挂到每一行（它靠这个把选中项滚进视野）。
export function MentionMenu({
  options,
  selectedIndex,
  selectOptionAndCleanUp,
  setHighlightedIndex,
}: {
  options: MentionOption[];
  selectedIndex: number | null;
  selectOptionAndCleanUp: (o: MentionOption) => void;
  setHighlightedIndex: (i: number) => void;
}) {
  return (
    <div
      data-mention-menu
      className='z-50 flex max-h-64 w-72 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-[12px] shadow-lg'
    >
      {options.map((o, i) => (
        <button
          key={o.key}
          ref={(el) => o.setRefElement(el)}
          type='button'
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => selectOptionAndCleanUp(o)}
          onMouseEnter={() => setHighlightedIndex(i)}
          className={cn(
            'flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left outline-none',
            selectedIndex === i ? 'bg-accent' : 'hover:bg-accent',
          )}
        >
          <UserAvatar name={o.candidate.nickname} src={o.candidate.avatar} size='sm' />
          <Username nickname={o.candidate.nickname} />
          <span className='min-w-0 truncate text-[11px] text-muted-foreground'>@{o.candidate.handle}</span>
        </button>
      ))}
    </div>
  );
}
