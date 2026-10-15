import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

// 管理后台的共享展示件（纯展示、非交互）。交互控件一律来自 Ring UI 或本目录的可复用控件。
// **待提升为 src/ui**：`Panel` / `StatRow` / `Pill` 这几个 12/13/14 页也能用，验证通过后应上移。

export function ScreenHead({ title, note, actions }: { title: string; note: string; actions?: ReactNode }) {
  return (
    <div className='flex flex-wrap items-start justify-between gap-2'>
      <div className='min-w-0'>
        <h2 className='text-[15px] font-semibold text-foreground'>{title}</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{note}</p>
      </div>
      {actions ? <div className='flex flex-wrap items-center gap-2'>{actions}</div> : null}
    </div>
  );
}

export function Panel({ title, note, actions, children, className, 'data-testid': testId }: {
  title?: string;
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <section data-testid={testId} className={cn('rounded-lg border border-border bg-card p-3', className)}>
      {title || actions ? (
        <div className='mb-2 flex flex-wrap items-start justify-between gap-2'>
          <div className='min-w-0'>
            {title ? <h3 className='text-[13px] font-semibold text-foreground'>{title}</h3> : null}
            {note ? <p className='text-[12px] leading-relaxed text-muted-foreground'>{note}</p> : null}
          </div>
          {actions ? <div className='flex flex-wrap items-center gap-1.5'>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'neutral', 'data-testid': testId }: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'info' | 'danger';
  'data-testid'?: string;
}) {
  return (
    <div data-testid={testId} className='min-w-[104px] flex-1 rounded-md border border-border bg-card px-3 py-2'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div className={cn('text-[17px] leading-tight font-semibold',
        tone === 'info' && 'text-primary',
        tone === 'danger' && 'text-destructive',
        tone === 'neutral' && 'text-foreground')}
      >
        {value}
      </div>
      {hint ? <div className='text-[11px] text-muted-foreground'>{hint}</div> : null}
    </div>
  );
}

export function StatRow({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid'?: string }) {
  return <div data-testid={testId} className='flex flex-wrap gap-2'>{children}</div>;
}

export function Pill({ tone = 'neutral', children, className }: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'outline';
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
        tone === 'ok' && 'bg-primary/12 text-primary',
        tone === 'warn' && 'bg-muted text-foreground ring-1 ring-border',
        tone === 'danger' && 'bg-destructive/12 text-destructive',
        tone === 'outline' && 'border border-dashed border-border text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function KV({ k, v, hint }: { k: string; v: ReactNode; hint?: string }) {
  return (
    <div className='flex items-start justify-between gap-3 border-b border-border py-1.5 last:border-0'>
      <span className='shrink-0 text-[12px] text-muted-foreground'>{k}</span>
      <span className='min-w-0 text-right text-[12px] text-foreground'>
        {v}
        {hint ? <span className='block text-[11px] text-muted-foreground'>{hint}</span> : null}
      </span>
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

/** 「权限不足就不渲染」的示例标记：**只在没权限时出现**，把隐藏的原因写在界面上（而不是悄悄藏掉）。 */
export function GateNote({ perm, children }: { perm: string; children: ReactNode }) {
  return (
    <div className='flex items-start gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground'>
      <ShieldAlert size={14} aria-hidden className='mt-0.5 shrink-0' />
      <span>
        <span className='font-medium text-foreground'>权限示例：</span>
        本账号未持有 <code className='rounded-sm bg-muted px-1'>{perm}</code>，{children}
        <span className='block'>
          前端权限只决定显不显示，真正的判定在后端（前端方案 §5.4 / 后端方案 §9.8）。
        </span>
      </span>
    </div>
  );
}

/** 「为什么禁用」：贴在禁用按钮旁边的一句话，避免「灰着但不说原因」。 */
export function DisabledReason({ children }: { children: ReactNode }) {
  return (
    <span className='inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
      <ShieldAlert size={12} aria-hidden />
      {children}
    </span>
  );
}

export function Numbers({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground'>
      {items.map((i) => (
        <span key={i.label}>
          {i.label} <span className='font-medium text-foreground'>{i.value}</span>
        </span>
      ))}
    </div>
  );
}