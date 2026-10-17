import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { RefreshCw } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 验证码：**两行**——第一行输入框（占满整行，与上面几个输入框对齐），第二行图块 + 「换一张」。
// 为什么不再挤一行：挤一行时图块只有 87×32 的细条、输入框被压到 240 宽，而且「换一张」是个
// 16×16 的纯图标按钮，看不出是什么（实测数据见回报）。真页面的图是 GET /api/v1/captcha 返回的
// image_base64；这里是设计页，用字符块代替（不引外部图片）。
// 无障碍：图块 aria-hidden（旁边的输入框有 label 与 help，读屏不会只听到一串字符）；
// 「换一张」有可见文字 + aria-label + title，键盘 Tab 得到。
export type CaptchaFieldProps = {
  chars: string[];
  value: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
  error?: string | null;
};

export function CaptchaField({ chars, value, onChange, onRefresh, error }: CaptchaFieldProps) {
  return (
    <div className='flex flex-col gap-2'>
      {/* error / help 属于这个 Input（库把它们渲染在框下方），所以第二行在它们之后，不会插到中间 */}
      <Input
        label='验证码'
        size={Size.FULL}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        help='请输入图片里的 4 个字符，不区分大小写'
        name='captcha'
        maxLength={4}
        autoComplete='off'
      />
      <div className='flex items-center gap-2'>
        {/* 图块：按真实验证码图的尺寸留位（约 120×40），不跟输入框挤在一行 */}
        <span
          aria-hidden
          className='grid h-10 min-w-[7.5rem] shrink-0 select-none place-items-center rounded-md border border-border bg-muted px-3 font-mono text-[20px] font-semibold tracking-[0.3em] text-foreground italic'
        >
          {chars.join('')}
        </span>
        {/* 必须显式 inline={false}：Ring 的 Button 只要带了 icon 就默认 inline
            （button.js: isInline = inline ?? text ?? !!icon），而 .ring-button-inline 是
            display:inline / padding:0 / 用链接色——height 变量会被旁路，量出来恒为 24px、看着像链接。
            显式关掉它，才拿得到一颗真按钮（L 档 32px，与 40px 的图块同高一行）。 */}
        <Button
          inline={false}
          height={ControlsHeight.L}
          icon={icon16(RefreshCw)}
          aria-label='换一张验证码'
          title={'换一张（当前：' + chars.join('') + '）'}
          onClick={() => onRefresh()}
        >
          换一张
        </Button>
      </div>
    </div>
  );
}
