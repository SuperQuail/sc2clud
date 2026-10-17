import Button from '@jetbrains/ring-ui-built/components/button/button';
import type { ReactNode } from 'react';
import { CountBadge } from './count-badge';

// 信息中心的左侧导航。**数据驱动**：谁用谁传 items，组件不知道业务。
// 行用 Ring 的 Button（ghost）——Ring 没有竖排导航件，但按钮是现成的。
export type NoticeNavItem = {
  key: string;
  label: string;
  /** 图标：调用方传 lucide 图标并自己 aria-hidden */
  icon?: ReactNode;
  /** 未读数（0/undefined 不显示） */
  count?: number;
  /** 分组标题（在这一项之前插入一条分隔标题） */
  groupTitle?: string;
};

export function NoticeNav({
  items,
  value,
  onChange,
  title,
  titleIcon,
}: {
  items: NoticeNavItem[];
  value: string;
  onChange: (key: string) => void;
  title?: string;
  titleIcon?: ReactNode;
}) {
  return (
    <nav aria-label={title ?? '信息中心'} className='flex min-w-44 flex-col gap-0.5'>
      {title ? (
        <span className='flex items-center gap-2 px-2 pt-1 pb-3 text-[15px] font-semibold text-foreground'>
          {titleIcon}
          {title}
        </span>
      ) : null}
      {items.map((item) => (
        <span key={item.key} className='flex flex-col gap-0.5'>
          {item.groupTitle ? (
            <span className='px-2 pt-4 pb-1 text-[12px] font-medium tracking-wide text-muted-foreground'>
              {item.groupTitle}
            </span>
          ) : null}
          <Button
            data-testid={'notice-nav-' + item.key}
            ghost
            active={value === item.key}
            onClick={() => onChange(item.key)}
            className='justify-start'
          >
            <span className='flex w-full items-center gap-2'>
              {item.icon}
              <span className='flex-1 text-left'>{item.label}</span>
              {item.count ? <CountBadge count={item.count} /> : null}
            </span>
          </Button>
        </span>
      ))}
    </nav>
  );
}
