import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 通用下拉面板（只读查看用）。**触发元素就是传进来的东西本身**——例如权限徽标、头衔徽标。
// 面板出现在下方（不是侧边抽屉）；Esc 或点外部关闭；键盘可达（Enter/Space 开合）。
// 放在 src/ui 里所以允许直接写 <button>（业务代码不许手写控件，gate:ui 会挡）。
export function DropdownPanel({
  trigger,
  children,
  label,
  align = 'left',
  width = 'w-80',
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  /** 无障碍名与面板标题 */
  label: string;
  align?: 'left' | 'right';
  width?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

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
      </button>
      {open ? (
        <span
          role='dialog'
          aria-label={label}
          className={cn(
            'absolute top-full z-50 mt-1.5 flex flex-col gap-2.5 rounded-md border border-border bg-popover p-3 text-[12px] shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
            width,
          )}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
