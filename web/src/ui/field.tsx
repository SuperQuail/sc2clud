import type { ReactNode } from 'react';
import { Label } from './label';
import { cn } from '@/lib/utils';

export type FieldProps = {
  label: string;
  htmlFor: string;
  error?: string;
  count?: { value: number; max: number };
  children: ReactNode;
};

// 标签、错误、计数的唯一实现：错误文案来自接口返回的 error.fields
export function Field({ label, htmlFor, error, count, children }: FieldProps) {
  const over = count ? count.value > count.max : false;
  return (
    <div className='flex flex-col gap-1.5'>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      <div className='flex items-center justify-between text-xs'>
        <span className='text-destructive' role='alert'>{error ?? ''}</span>
        {count ? (
          <span className={cn('tabular-nums', over ? 'text-destructive' : 'text-muted-foreground')}>
            {count.value}/{count.max}
          </span>
        ) : null}
      </div>
    </div>
  );
}
