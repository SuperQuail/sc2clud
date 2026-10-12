import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 通用下拉面板。触发元素就是传进来的东西本身（徽标 / 按钮）。
// 它只管三件事：展开/收起、点外部与 Esc 关闭、向上/向下自适应。
// **不画箭头**：可点标记是触发器自己的事——A 系用 Ring UI Button 自带的 dropdown 箭头，
// B 系用 VividButton / VividSelect 自己渲染（曾经在面板里给任意触发器旁边画三角，属于画蛇添足）。
// 面板样式：表头 + 内容区 + 圆角/阴影/最大高度滚动，条目统一用 DropdownItem。
export type DropdownDirection = 'down' | 'up' | 'auto';

export function DropdownPanel({
  trigger,
  children,
  label,
  align = 'left',
  width = 'w-72',
  direction = 'auto',
  className,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  align?: 'left' | 'right';
  width?: string;
  direction?: DropdownDirection;
  className?: string;
  /** 传了就是受控模式（父组件决定开合，例如选中一项后主动关闭） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = (v: boolean) => {
    setInnerOpen(v);
    onOpenChange?.(v);
  };
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
        onClick={() => setOpen(!open)}
        className={cn('inline-flex cursor-pointer items-center rounded-[5px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', className)}
      >
        {trigger}
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
