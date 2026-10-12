import Button from '@jetbrains/ring-ui-built/components/button/button';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 大号切换列（参考 B 站空间页：图标 + 文字 + 计数，选中项下面一条粗线）。
// **为什么不用 Ring 的 Tabs**：Ring 的 Tabs 是紧凑小字条，放大要覆盖它内部的类名——
// 而「不许覆盖控件库样式」是硬规矩。这里改用 Ring 的 Button 做基座（ghost + active），
// 外观完全由我们用令牌控制，键盘与焦点行为仍然是库的。
// 数据驱动：items / value / onChange，组件不认识业务。
export type IconTabItem = {
  key: string;
  label: string;
  /** 图标：调用方传入（自己带 aria-hidden 与尺寸） */
  icon?: ReactNode;
  /** 右侧计数，例如「帖子 42」 */
  count?: number;
};

export function IconTabs({
  items,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  items: IconTabItem[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={cn('flex flex-wrap items-stretch gap-1 border-b border-border', className)}>
      {items.map((item) => {
        const active = value === item.key;
        return (
          <span key={item.key} className='relative flex'>
            <Button
              data-testid={'icon-tab-' + item.key}
              ghost
              active={active}
              onClick={() => onChange(item.key)}
              className='h-12 gap-2 px-4 text-[16px]'
            >
              <span className='flex items-center gap-2'>
                {item.icon}
                <span>{item.label}</span>
                {typeof item.count === 'number' ? (
                  <span className='tabular-nums text-[13px] text-muted-foreground'>{item.count}</span>
                ) : null}
              </span>
            </Button>
            {active ? (
              <span aria-hidden className='pointer-events-none absolute inset-x-4 bottom-0 h-[3px] rounded-t bg-primary' />
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
