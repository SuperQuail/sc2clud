import { useState } from 'react';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Eye, EyeOff } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { ReactNode } from 'react';

// 密码框 = Ring UI Input + 一个显示/隐藏按钮。**不手写 input**：
// 掩码靠 Input 自己的 type，切换靠 Button 的 aria-pressed。
// 按钮为什么放在输入框右边而不是框内：Ring Input 没有 suffix 槽位，
// 而把按钮绝对定位到框里就得改库的 padding 变量（§7.5 明令禁止覆盖库的尺寸变量）。
export type PasswordFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 来自服务端 error.fields，直接喂 Input 的 error prop */
  error?: string | null;
  help?: ReactNode;
  name?: string;
  placeholder?: string;
  /** 登录用 current-password，注册/重置用 new-password（浏览器密码管理器认这个） */
  autoComplete?: 'current-password' | 'new-password';
};

export function PasswordField({ label, value, onChange, error, help, name, placeholder, autoComplete }: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className='flex items-end gap-1.5'>
      <div className='min-w-0 flex-1'>
        <Input
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
      </div>
      <Button
        ghost
        icon={icon16(shown ? EyeOff : Eye)}
        aria-pressed={shown}
        aria-label={shown ? '隐藏密码' : '显示密码'}
        title={shown ? '隐藏密码' : '显示密码'}
        onClick={() => setShown((s) => !s)}
      />
    </div>
  );
}
