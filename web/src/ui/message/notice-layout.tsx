import type { ReactNode } from 'react';

// 信息中心的两栏骨架：左边导航、右边内容。两边都由调用方给，组件不认识业务。
export function NoticeLayout({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className='grid gap-5 lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]'>
      <div className='flex flex-col'>{nav}</div>
      <div className='flex min-w-0 flex-col gap-4'>{children}</div>
    </div>
  );
}
