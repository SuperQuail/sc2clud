import { useId, type InputHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// 设计语言 B 的输入框：大、圆、柔和。与 Ring UI 的 Input 是**同一种控件的两种样式**，
// 由场景决定用哪个（访客页面用这个，发帖/管理用 Ring UI 那个）。
const SIZE = { md: 'h-11 rounded-full px-4', lg: 'h-14 rounded-2xl px-5' } as const;

// 注意：原生 input 也有 size（number，字符宽度），会把这个 size 交叉成 never —— 必须先 Omit 掉
export type VividInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label?: string;
  hint?: string;
  error?: string;
  icon?: LucideIcon;
  size?: keyof typeof SIZE;
};

export function VividInput({ label, hint, error, icon: Icon, size = 'md', className, id, ...props }: VividInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = error || hint ? inputId + '-desc' : undefined;
  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={inputId} className='text-sm font-medium text-foreground'>
          {label}
        </label>
      ) : null}
      <div
        className={cn(
          'flex items-center gap-2 border bg-background transition-colors focus-within:ring-[3px] focus-within:ring-ring/30',
          SIZE[size],
          error ? 'border-destructive' : 'border-input',
        )}
      >
        {Icon ? <Icon aria-hidden className='size-5 shrink-0 text-muted-foreground' /> : null}
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={descId}
          className='min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground'
          {...props}
        />
      </div>
      {error ? (
        <p id={descId} className='text-[13px] text-destructive'>{error}</p>
      ) : hint ? (
        <p id={descId} className='text-[13px] text-muted-foreground'>{hint}</p>
      ) : null}
    </div>
  );
}
