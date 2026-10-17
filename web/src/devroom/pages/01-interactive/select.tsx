import { useState } from 'react';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Line, Pair } from '@/devroom/kit';

const SORTS = [
  { key: 'new', label: '最新回复' },
  { key: 'created', label: '最新发布' },
  { key: 'hot', label: '最多回复' },
];

// 下拉选择一律用 Ring 的：我们自制的 B 系下拉（VividSelect）观感不行，已删除。
// 这里对照的是 Ring 自己的两种模式：INPUT（表单里用）与 BUTTON（工具条里用）。
export function SelectPair() {
  const [sort, setSort] = useState<string | null>('new');
  const selected = SORTS.find((s) => s.key === sort) ?? null;
  const onSelect = (item: (typeof SORTS)[number] | null) => {
    if (item) setSort(String(item.key));
  };
  return (
    <Pair
      name='下拉选择（Ring 原生 · 两种模式）'
      note='下拉一律用 Ring 的（自制的 B 系版本已删除）。左＝type=INPUT（表单里用，输入框外观）；右＝type=BUTTON（工具条里用）。选中标记与弹层全走 Ring 自己的实现。'
      user={
        <Line label='INPUT 模式（表单）' hint='标签在控件内，选中项打勾，展开不重复标题'>
          <Select type={SelectType.INPUT} label='排序方式' data={SORTS} selected={selected} onSelect={onSelect} />
        </Line>
      }
      dev={
        <Line label='BUTTON 模式（工具条）'>
          <Select type={SelectType.BUTTON} data={SORTS} selected={selected} onSelect={onSelect} />
        </Line>
      }
    />
  );
}
