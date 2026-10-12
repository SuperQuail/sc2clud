import type { ReactNode } from 'react';
import DropdownMenu from '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu';
import PopupMenu from '@jetbrains/ring-ui-built/components/popup-menu/popup-menu';
import { Directions } from '@jetbrains/ring-ui-built/components/popup/popup.consts';

// 「点任意元素弹出一块自定义内容」的浮层，**实现全部交给 Ring**：
//   DropdownMenu 管锚点的开合与它在 Popup 里的定位、点外部关闭、Esc、方向自适应；
//   我们只提供触发元素与内容。
// 关键点（第一次没做成的原因）：**anchor 要用渲染函数形式**，
//   Ring 通过参数把开合属性交给调用方，必须把它们落到触发元素上；
//   直接传 <span>{trigger}</span> 这种元素形式，属性落不到可点元素上，浮层打不开。
// 对外 API 与之前一致，所以使用方（07 页权限明细）不需要改。
export type DropdownDirection = 'down' | 'up' | 'auto';

export function DropdownPanel({
  trigger,
  children,
  label,
  align = 'left',
  width = 'w-72',
  direction = 'auto',
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  /** 无障碍名 */
  label: string;
  align?: 'left' | 'right';
  width?: string;
  /** auto = 由 Popup 按空间自己决定上下（默认） */
  direction?: DropdownDirection;
  className?: string;
}) {
  const dirs =
    direction === 'up'
      ? [align === 'right' ? Directions.TOP_RIGHT : Directions.TOP_LEFT]
      : direction === 'down'
        ? [align === 'right' ? Directions.BOTTOM_RIGHT : Directions.BOTTOM_LEFT]
        : undefined;

  return (
    <DropdownMenu
      ariaLabel={label}
      anchor={(anchorProps, ariaProps) => (
        // 触发元素本身：注入的属性必须落在这里，否则点不开
        <button
          type='button'
          {...anchorProps}
          {...ariaProps}
          className={
            'inline-flex cursor-pointer items-center rounded-[5px] bg-transparent p-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ' +
            (className ?? '')
          }
        >
          {trigger}
        </button>
      )}
      children={(props) => (
        // data 传空数组：这是内容浮层，不是菜单项列表；内容通过 children 进 List 容器
        <PopupMenu {...props} data={[]} ariaLabel={label} directions={dirs} className={width}>
          <span className='flex flex-col gap-2.5 p-3 text-[12px]'>{children}</span>
        </PopupMenu>
      )}
    />
  );
}
