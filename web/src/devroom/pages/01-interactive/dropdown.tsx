import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import DropdownMenu from '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu';
import { Line, Pair } from '@/devroom/kit';

// 下拉菜单，**用 Ring 原生的 DropdownMenu**：定位、点外部关闭、Esc、键盘导航、
// 溢出纠偏都是它自己的事——我们之前手写的 DropdownPanel 就是在重复这些（而且做不全）。
const SORTS = [
  { key: 'new', label: '最新回复' },
  { key: 'created', label: '最新发布' },
  { key: 'hot', label: '最多回复' },
];

export function DropdownPair() {
  const [sort, setSort] = useState('new');
  const current = SORTS.find((s) => s.key === sort)?.label ?? '排序';
  const menu = (
    <DropdownMenu
      anchor={<Button>{current}</Button>}
      data={SORTS}
      onSelect={(item) => setSort(String(item.key))}
    />
  );
  return (
    <Pair
      name='下拉菜单 DropdownMenu'
      note='点 anchor 展开；数据用 data 传，选中回 onSelect。**不要自己写浮层**——定位、点外关闭、Esc、键盘导航都在控件里。'
      user={
        <Line label='默认'>
          {menu}
          <span className='text-[12px] text-muted-foreground'>当前：{current}</span>
        </Line>
      }
      dev={
        <Line label='图标 anchor（管理表格里用）'>
          <DropdownMenu
            anchor={<Button>更多操作</Button>}
            data={[
              { key: 'pin', label: '置顶' },
              { key: 'lock', label: '锁定' },
              { key: 'del', label: '删除' },
            ]}
            onSelect={() => {}}
          />
        </Line>
      }
    />
  );
}
