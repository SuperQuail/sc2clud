import { useState } from 'react';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Line, Pair } from '@/devroom/kit';
import { VividSelect } from '@/ui/vivid/select';

const SORTS = [
  { key: 'new', label: '最新回复' },
  { key: 'created', label: '最新发布' },
  { key: 'hot', label: '最多回复' },
];

export function SelectPair() {
  const [sort, setSort] = useState<string | null>('new');
  const selectedSort = SORTS.find((s) => s.key === sort) ?? null;
  return (
    <Pair
      name='下拉选择 Select'
      note='**下拉是表单控件，不是按钮**：B 系 VividSelect 与输入框同高同圆角；A 系 Ring UI Select 用 type=INPUT，选中标记走 Ring 原生。两者展开后都不重复标题，当前项打勾。'
      user={
        <Line label='默认 / 带标签 / 禁用'>
          <div className='w-52'><VividSelect options={SORTS} value={sort} onChange={setSort} /></div>
          <div className='w-52'><VividSelect label='排序方式' options={SORTS} value={sort} onChange={setSort} /></div>
          <div className='w-52'><VividSelect label='禁用' options={SORTS} onChange={() => {}} disabled /></div>
        </Line>
      }
      dev={
        <Line label='INPUT 类型（表单里用，Ring 原生行为）'>
          <Select
            type={SelectType.INPUT}
            label='排序方式'
            data={SORTS}
            selected={selectedSort}
            onSelect={(item) => {
              if (item) setSort(String(item.key));
            }}
          />
        </Line>
      }
    />
  );
}
