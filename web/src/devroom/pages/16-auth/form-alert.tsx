import type { ReactNode } from 'react';
import { CircleAlert, CircleCheckBig, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// 表单里的**行内提示**（错误 / 警告 / 成功 / 说明）。
// 为什么不用 Ring UI 的 ErrorMessage：它是**页面级**组件——21px 标题、64px 图标、水平居中、height:100%
// （实测 .ring-error-message-errorMessage / -title），塞进 420 宽的表单卡片里像一页 500。
// 所以这里按 §1 的规矩做一次封装：只写外观与组合，不自己实现控件（图标是 lucide，文案由调用方给）。
// 无障碍：错误与警告 role="alert"（读屏立刻播报），成功与说明 role="status"。
export type AlertTone = 'error' | 'warning' | 'success' | 'info';

export type FormAlertProps = {
  tone: AlertTone;
  title: string;
  description?: ReactNode;
  /** 提示里的动作（例如「重新发送」按钮） */
  children?: ReactNode;
};

const TONE: Record<AlertTone, { icon: LucideIcon; box: string; label: string }> = {
  error: { icon: CircleAlert, box: 'border-destructive/40 bg-destructive/8', label: '错误' },
  warning: { icon: TriangleAlert, box: 'border-[var(--ring-warning-color)]/40 bg-[color:color-mix(in_srgb,var(--ring-warning-color)_10%,transparent)]', label: '注意' },
  success: { icon: CircleCheckBig, box: 'border-[var(--ring-icon-success-color)]/40 bg-[color:color-mix(in_srgb,var(--ring-icon-success-color)_10%,transparent)]', label: '成功' },
  info: { icon: Info, box: 'border-border bg-muted/60', label: '说明' },
};

const ICON_COLOR: Record<AlertTone, string> = {
  error: 'text-destructive',
  warning: 'text-[var(--ring-warning-color)]',
  success: 'text-[var(--ring-icon-success-color)]',
  info: 'text-muted-foreground',
};

export function FormAlert({ tone, title, description, children }: FormAlertProps) {
  const { icon: Icon, box, label } = TONE[tone];
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      aria-live={tone === 'error' || tone === 'warning' ? 'assertive' : 'polite'}
      className={cn('flex gap-2 rounded-md border p-3 text-[13px]', box)}
    >
      <Icon size={16} aria-hidden className={cn('mt-0.5 shrink-0', ICON_COLOR[tone])} />
      <div className='flex min-w-0 flex-col gap-1'>
        {/* 读屏时先说语气，再读正文 */}
        <span className='sr-only'>{label + '：'}</span>
        <span className='font-medium text-foreground'>{title}</span>
        {description ? <span className='leading-relaxed text-muted-foreground'>{description}</span> : null}
        {children}
      </div>
    </div>
  );
}
