import { useState } from 'react';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Eye, EyeOff } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { ReactNode } from 'react';

// 自建控件：密码框 = Ring UI Input + **框内右侧**的「显示/隐藏」按钮（登记名 password-field，见 registry.ts）。
// 不手写 input：掩码靠 Input 自己的 type。
// 为什么它在 src/ui 而不是页面目录：它已经是「Ring Input + 框内绝对定位眼睛」的自建控件，
// 三个视图（登录/注册/找回）都在用；房间的规矩是**先验证、再登记、才能用**。
//
// 为什么眼睛要绝对定位：Ring 的 Input **没有尾部槽位**（input.d.ts 里只有前置 icon、inputClassName、
// clearButtonClassName），所以只能「外层 relative + 给输入框留右内边距 + 绝对定位压上去」。
// 垂直偏移不是猜的：输入行距外层容器顶 **20px**（= label 行盒 16px + .ring-control-label-label 的
// margin-bottom 4px），而 help 与 error 都渲染在输入行**下方**，所以「有 label / 有 help / 有 error」
// 三种情况量出来都是 20px——同一个值三种都成立，因此可以写死成 CSS 类（见下面 top-[20px]）。
//
// 无障碍：aria-pressed 表达开关状态，aria-label/title 说明动作；Ring 的 Button 是原生 <button>，
// Tab 可达、Enter/Space 可切换。眼睛不覆盖整行宽度，所以点输入区照常聚焦。
export type PasswordFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 来自服务端 error.fields，直接喂 Input 的 error prop */
  error?: string | null;
  help?: ReactNode;
  name?: string;
  placeholder?: string;
  /**
   * **真页面**（routes/ 里的登录/注册/重置）要传 'current-password' / 'new-password'，
   * 浏览器密码管理器要靠它认字段。
   * 默认 'off' 是给 **DevRoom 演示页**的：那是一张公开部署的设计预览页，不该邀请密码管理器
   * 把访客的真实口令填进来。演示页的调用点因此**不传**这个 prop（见 login/register/forgot 三个视图）。
   */
  autoComplete?: 'off' | 'current-password' | 'new-password';
};

export function PasswordField({ label, value, onChange, error, help, name, placeholder, autoComplete = 'off' }: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className='relative'>
      <Input
        // Ring 的 Input 默认 sizeM=240px（.ring-input-sizeM），表单里必须 Size.FULL 才与其它输入框等宽；
        // 这是库自带的 100%，不是我们压它的样式。
        size={Size.FULL}
        // 框内右侧留位：2px 缩进 + 28px 按钮 + 6px 间隙 = 36px。
        // **为什么要 `pr-9!`（important）**：Ring 的 .ring-input-input 是**未分层**（unlayered）的 CSS，
        // 而 Tailwind 的工具类在 @layer utilities 里 —— CSS 级联里未分层样式永远压过分层样式，
        // 所以普通 `pr-9` 量出来仍是库的 8px（我实测过：padding-right=8px，文字会跑到眼睛下面）。
        // 这一处用 !important 是有意的：库没有尾部槽位，右内边距是我们唯一能留位的手段。
        inputClassName='pr-9!'
        label={label}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        help={help}
        name={name}
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
      {/* top-[20px] 由实测得来（见文件头）；h-7=28px 就是输入行高，眼睛在行内垂直居中 */}
      <span className='absolute top-[20px] right-0.5 flex h-7 items-center'>
        {/* inline={false} 必须显式写：Ring 的 Button 只要带 icon 就默认 inline
            （isInline = inline ?? text ?? !!icon），会变成 24px 的链接样式并**旁路 height**。 */}
        <Button
          inline={false}
          ghost
          height={ControlsHeight.S}
          icon={icon16(shown ? EyeOff : Eye)}
          aria-pressed={shown}
          aria-label={shown ? '隐藏密码' : '显示密码'}
          title={shown ? '隐藏密码' : '显示密码'}
          onClick={() => setShown((s) => !s)}
        />
      </span>
    </div>
  );
}
