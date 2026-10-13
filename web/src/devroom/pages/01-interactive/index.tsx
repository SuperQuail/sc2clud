import { Pending } from '@/devroom/kit';
import { ButtonPair } from './button';
import { ChoicePair } from './choice';
import { DropdownPair } from './dropdown';
import { InputPair } from './input';
import { SelectPair } from './select';
import { TogglePair } from './toggle';

// DevRoom 01 · 交互与表单
// 一个控件一个文件（本目录下），页面只负责组装；公共骨架在 @/devroom/kit。
// 格式统一：左 B 系（用户向）／右 A 系（开发者向）。
export default function InteractivePage() {
  return (
    <div className='flex flex-col gap-6'>
      <ButtonPair />
      <InputPair />
      <TogglePair />
      <SelectPair />
      <ChoicePair />
      <DropdownPair />
      <Pending
        items={['工具条下拉']}
        note='复选/单选/按钮组/下拉菜单本次已用 Ring 补上。工具条下拉：自制的已废弃，用 Ring 的 DropdownMenu（已登记）。另：图标工具 icon16 / 官方图标在第 05 页。'
      />
    </div>
  );
}
