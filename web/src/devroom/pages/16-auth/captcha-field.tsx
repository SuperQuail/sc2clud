import Input from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { RefreshCw } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 验证码：图块 + 换一张 + 输入框。
// 真页面的图是 GET /api/v1/captcha 返回的 image_base64；这里是设计页，用字符块代替（不引外部图片）。
// 无障碍：图块本身 aria-hidden（旁边的输入框有 label 与 help，读屏不会只听到一串字符）。
export type CaptchaFieldProps = {
  chars: string[];
  value: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
  error?: string | null;
};

export function CaptchaField({ chars, value, onChange, onRefresh, error }: CaptchaFieldProps) {
  return (
    <div className='flex items-end gap-1.5'>
      <div className='min-w-0 flex-1'>
        <Input
          label='验证码'
          value={value}
          onChange={(e) => onChange(e.target.value)}
          error={error}
          help='请输入图片里的 4 个字符，不区分大小写'
          name='captcha'
          maxLength={4}
          autoComplete='off'
        />
      </div>
      <span
        aria-hidden
        className='grid h-8 select-none place-items-center rounded-md border border-border bg-muted px-3 font-mono text-[18px] font-semibold tracking-[0.3em] text-foreground italic'
      >
        {chars.join('')}
      </span>
      <Button
        ghost
        icon={icon16(RefreshCw)}
        aria-label='换一张验证码'
        title={'换一张（当前：' + chars.join('') + '）'}
        onClick={() => onRefresh()}
      />
    </div>
  );
}
