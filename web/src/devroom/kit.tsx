import type { ReactNode } from 'react';

// DevRoom 的页面骨架。**所有页面都用这里的东西**，不要再各自写一份 Card/Row/Pair——
// 之前 05/06/07 三个页面各复制了一套，改一处要改三处（这就是不规范）。
export function Card({ name, note, children }: { name: string; note: string; children: ReactNode }) {
  return (
    <section className='rounded-lg border border-border bg-card p-3'>
      <h2 className='text-sm font-semibold text-foreground'>{name}</h2>
      <p className='mb-1 text-[12px] leading-relaxed text-muted-foreground'>{note}</p>
      {children}
    </section>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-2 border-b border-border py-3 last:border-0'>
      <span className='flex flex-wrap items-baseline gap-2'>
        <span className='text-[12px] font-medium text-foreground'>{label}</span>
        {hint ? <span className='text-[11px] text-muted-foreground'>{hint}</span> : null}
      </span>
      <span className='flex flex-wrap items-center gap-x-6 gap-y-3'>{children}</span>
    </div>
  );
}

export function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='text-[11px] text-muted-foreground'>{label}</span>
      <span className='flex flex-wrap items-center gap-2'>{children}</span>
    </div>
  );
}

// 一种控件两种样式：左 B 系（用户向）／右 A 系（开发者向）。DevRoom 01 的统一格式。
export function Pair({
  name,
  note,
  user,
  dev,
}: {
  name: string;
  note: string;
  user: ReactNode;
  dev: ReactNode;
}) {
  return (
    <section className='flex flex-col gap-2'>
      <div>
        <h2 className='text-sm font-semibold text-foreground'>{name}</h2>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{note}</p>
      </div>
      <div className='grid gap-3 lg:grid-cols-2'>
        <div className='flex flex-col gap-4 rounded-lg border border-border bg-card p-3'>
          <span className='flex items-baseline gap-2'>
            <span className='rounded-sm bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary'>B 系 · 用户向</span>
            <span className='text-[11px] text-muted-foreground'>首页 / 分区页 / 帖子页</span>
          </span>
          {user}
        </div>
        <div className='flex flex-col gap-4 rounded-lg border border-border bg-card p-3'>
          <span className='flex items-baseline gap-2'>
            <span className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground'>A 系 · 开发者向</span>
            <span className='text-[11px] text-muted-foreground'>发帖 / 管理 / 密集列表</span>
          </span>
          {dev}
        </div>
      </div>
    </section>
  );
}

// 页面还没做对照的控件，统一列在这里，避免每个页面各写一份。
export function Pending({ items, note }: { items: string[]; note: string }) {
  return (
    <section className='rounded-lg border border-dashed border-border p-3'>
      <h2 className='text-sm font-semibold text-foreground'>还没做对照的控件</h2>
      <p className='text-[12px] leading-relaxed text-muted-foreground'>{note}</p>
      <div className='mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground'>
        {items.map((t) => (
          <span key={t} className='rounded-sm bg-muted px-1.5 py-0.5'>{t}</span>
        ))}
      </div>
    </section>
  );
}
