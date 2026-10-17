import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 设计语言 B 的开关：大、圆润。与 Ring UI 的 Toggle 是**同一种控件的两种样式**。
// 原生 <button role=switch>，键盘与屏幕阅读器天然可用。
// 旋钮颜色走 --switch-knob（**两种主题下都是浅色**）：用 --background 会在夜间变黑（踩过）。
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
  const hintId = hint ? id + '-hint' : undefined;
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <button
        type='button'
        role='switch'
        id={id}
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        aria-describedby={hintId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors outline-none',
          'focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45',
          checked ? 'border-primary bg-primary' : 'border-border bg-[var(--switch-track)]',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'block size-5 rounded-full shadow-sm transition-transform motion-reduce:transition-none',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
          style={{ backgroundColor: 'var(--switch-knob)' }}
        />
      </button>
      {label || hint ? (
        <span className='flex min-w-0 flex-col'>
          {label ? <label htmlFor={id} className='cursor-pointer text-sm font-medium text-foreground'>{label}</label> : null}
          {hint ? <span id={hintId} className='text-[12px] text-muted-foreground'>{hint}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
