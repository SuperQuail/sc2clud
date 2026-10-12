import { useId, useState } from 'react';
import { DropdownItem, DropdownPanel } from '@/ui/dropdown-panel';
import { cn } from '@/lib/utils';

// 设计语言 B 的下拉选择。**它是表单控件，不是按钮**——外观对齐输入框（边框、高度、圆角、占位色），
// 右侧箭头是控件自己的一部分。展开/收起的行为交给 DropdownPanel。
// 对照物是 Ring UI 的 Select（type=INPUT 时也是输入框外观）。
const SIZE = { md: 'h-11 rounded-full px-4', lg: 'h-14 rounded-2xl px-5' } as const;

export type VividSelectOption = { key: string; label: string };

export function VividSelect({
  options,
  value,
  onChange,
  label,
  placeholder = '请选择…',
  size = 'md',
  disabled = false,
  className,
}: {
  options: VividSelectOption[];
  value?: string | null;
  onChange: (key: string) => void;
  label?: string;
  placeholder?: string;
  size?: keyof typeof SIZE;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === value);
  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={id} className='text-sm font-medium text-foreground'>
          {label}
        </label>
      ) : null}
      <DropdownPanel
        label={label ?? '选择'}
        width='w-full'
        className='block w-full'
        open={open}
        onOpenChange={setOpen}
        trigger={
          <span
            id={id}
            className={cn(
              'flex w-full items-center justify-between gap-2 border border-input bg-background text-[15px]',
              SIZE[size],
              disabled && 'pointer-events-none opacity-45',
            )}
          >
            <span className={cn('truncate', current ? 'text-foreground' : 'text-muted-foreground')}>
              {current?.label ?? placeholder}
            </span>
            <span
              aria-hidden
              className={cn(
                'size-0 shrink-0 border-x-[4px] border-t-[5px] border-x-transparent border-t-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </span>
        }
      >
        {options.map((o) => (
          <DropdownItem
            key={o.key}
            onClick={() => {
              onChange(o.key);
              setOpen(false);
            }}
            selected={o.key === value}
            className={o.key === value ? 'bg-accent font-medium' : undefined}
          >
            {o.label}
          </DropdownItem>
        ))}
      </DropdownPanel>
    </div>
  );
}
