import { Pending } from '@/devroom/kit';
import { ButtonPair } from './button';
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
      <Pending
        items={['Checkbox', 'Radio', '工具条下拉']}
        note='复选/单选：B 系还没做。工具条下拉：我们自己做的那版观感不行已废弃，**暂时一律用 Ring 的**——Ring 的 Dropdown/PopupMenu 还没在 DevRoom 验证，验证并登记后才能进业务代码。另：图标工具 icon16 / 官方图标在第 05 页。'
      />
    </div>
  );
}
