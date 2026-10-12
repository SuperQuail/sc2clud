import type { ReactNode } from 'react';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';

// 邮箱验证码输入（6 位数字）。**为什么是一个输入框而不是 6 格**：
//   ① 手机/浏览器的「从邮件自动填充」只认单个 input 的 autocomplete="one-time-code"，拆成 6 格自动填充就废了；
//   ② 6 格要么手写 6 个 <input>（§1 硬规则禁止），要么做一个隐藏 input + 6 个假格的控件——那是 src/ui 的活，
//      而且粘贴/选区/读屏都要自己兜，得不偿失。
// 尺寸：height L（库里最高的一档）+ 居中 + 字距，让这一格看起来就是「一串码」。
// 字号是**这一处有意的例外**：Ring 的 .ring-input 自己写死 font-size: var(--ring-font-size)，
// Tailwind 工具类在 @layer 里压不过未分层的库样式，而改 --ring-font-size 又是明令禁止的变量覆盖。
// 所以这里用内联 fontSize 只作用于「验证码」这一个字段（不碰颜色、不碰任何库变量、不改全局），
// 并且写进回报请 Lead 定：要不要把它提升成 src/ui 的一个控件，代价是要在库里包一层 Ring Input。
export type CodeFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** 服务端的统一失败文案（§11.4：不区分输错与过期） */
  error?: string | null;
  help?: ReactNode;
  autoFocus?: boolean;
};

export function CodeField({ value, onChange, error, help, autoFocus }: CodeFieldProps) {
  return (
    <div className='mx-auto w-full max-w-[240px]'>
      <Input
        label='验证码'
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        error={error}
        help={help}
        name='code'
        inputMode='numeric'
        autoComplete='one-time-code'
        maxLength={6}
        placeholder='000000'
        inputClassName='text-center tracking-[0.35em]'
        // 只作用于本字段的排版：字号 + 字距（详见文件头的说明）
        style={{ fontSize: 20 }}
        height={ControlsHeight.L}
        autoFocus={autoFocus}
      />
    </div>
  );
}
