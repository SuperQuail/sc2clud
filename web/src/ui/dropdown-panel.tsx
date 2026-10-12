import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 通用下拉面板。触发元素就是传进来的东西本身（徽标 / 按钮）。
// 三件它必须自己负责的事：
//   ① **可点标记**：默认在触发元素右侧画一个 CSS 三角（不用图标/emoji），展开时翻转；
//   ② **自己的样式**：表头 + 内容区 + 圆角/阴影/最大高度滚动，条目有 hover 态（DropdownItem）；
//   ③ **向上/向下**：direction=auto 时打开后测量，下方放不下且上方够就向上弹。
export type DropdownDirection = 'down' | 'up' | 'auto';

export function DropdownPanel({
  trigger,
  children,
  label,
  align = 'left',
  width = 'w-72',
  direction = 'auto',
  marker = true,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  align?: 'left' | 'right';
  width?: string;
  direction?: DropdownDirection;
  /** 是否在触发元素旁画可点三角 */
  marker?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<'down' | 'up'>('down');
  const wrap = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLSpanElement>(null);

  // 打开后测量：下方不够、上方够 → 向上弹
  useLayoutEffect(() => {
    if (!open) return;
    if (direction !== 'auto') {
      setDir(direction);
      return;
    }
    const r = wrap.current?.getBoundingClientRect();
    const h = panel.current?.getBoundingClientRect().height ?? 0;
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    setDir(below < h + 16 && r.top > h + 16 ? 'up' : 'down');
  }, [open, direction]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={wrap} className='relative inline-flex'>
      <button
        type='button'
        aria-haspopup='dialog'
        aria-expanded={open}
        aria-label={label + '（点击展开）'}
        onClick={() => setOpen((v) => !v)}
        className={cn('inline-flex cursor-pointer items-center rounded-[5px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}
      >
        {trigger}
        {marker ? (
          <span
            aria-hidden
            className={cn(
              'ml-1 inline-block size-0 border-x-[4px] border-t-[5px] border-x-transparent border-t-current opacity-60 transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        ) : null}
      </button>
      {open ? (
        <span
          ref={panel}
          role='dialog'
          aria-label={label}
          className={cn(
            'absolute z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-[12px] shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
            dir === 'down' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
            width,
          )}
        >
          <span className='border-b border-border bg-muted/60 px-3 py-1.5 text-left text-[11px] font-semibold text-muted-foreground'>{label}</span>
          <span className='flex max-h-72 flex-col overflow-y-auto p-1 text-left'>{children}</span>
        </span>
      ) : null}
    </span>
  );
}

// 菜单项：统一样式（hover/focus 一致），需要可点时用 <button>，只读用 <span>。
export function DropdownItem({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const base = cn(
    'flex w-full items-center justify-between gap-3 rounded-[4px] px-2 py-1.5 text-foreground transition-colors',
    onClick && 'cursor-pointer hover:bg-accent focus-visible:bg-accent outline-none',
    className,
  );
  return onClick ? (
    <button type='button' onClick={onClick} className={base}>{children}</button>
  ) : (
    <span className={base}>{children}</span>
  );
}
