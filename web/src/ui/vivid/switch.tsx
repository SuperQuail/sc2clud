import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 设计语言 B 的开关：大、圆润。与 Ring UI 的 Toggle 是**同一种控件的两种样式**。
// 原生 <button> + role=switch，所以键盘（Space/Enter）与屏幕阅读器都天然可用。
export type VividSwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
};

export function VividSwitch({ checked, onChange, label, hint, disabled = false, className }: VividSwitchProps) {
  const id = useId();
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <button
        type='button'
        role='switch'
        id={id}
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors outline-none',
          'focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45',
          checked ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'block size-5 rounded-full bg-background shadow transition-transform motion-reduce:transition-none',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
      {label || hint ? (
        <label htmlFor={id} className='flex min-w-0 flex-col'>
          {label ? <span className='text-sm font-medium text-foreground'>{label}</span> : null}
          {hint ? <span className='text-[12px] text-muted-foreground'>{hint}</span> : null}
        </label>
      ) : null}
    </span>
  );
}
