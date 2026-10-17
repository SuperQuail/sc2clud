import { cn } from '@/lib/utils';
import { UserAvatar, type UserAvatarSize } from '@/ui/user/avatar';

// 「头像本身就是上传入口」的唯一实现（2026-10-14 用户要求）。
//
// 用户原话：**不做独立按钮**，只在鼠标放到头像上显示「替换图像」文本、并在头像上加暗色滤镜，
// 点击头像弹出图片选择器。
//
// 为什么放在 src/ui：业务代码不许手写 <button>（gate:ui 会挡），而「整个头像就是可点区域 + 上面盖一层文字」
// 没法用 Ring Button 的尺寸规则表达（它自带 height 与 padding，塞进圆形头像会撑破）。
// 头像是 src/ui/user/avatar 的 UserAvatar（全站用户头像的唯一实现），这里只加交互与覆盖层。
export type AvatarPickerProps = {
  nickname: string;
  src?: string | null;
  size?: UserAvatarSize;
  /** 点了之后打开图片选择器；调用方接的是已挂好的上传器句柄 open()（headless 形态的 ImageUploader） */
  onPick: () => void;
  /** 覆盖层文案 */
  label?: string;
  /** 看别人主页时传：**明确禁用 + 说清原因**（画一颗点了没反应的，比缺一个入口更糟） */
  disabledReason?: string;
  className?: string;
};

export function AvatarPicker({
  nickname,
  src,
  size = 'xl',
  onPick,
  label = '替换图像',
  disabledReason,
  className,
}: AvatarPickerProps) {
  const disabled = Boolean(disabledReason);
  return (
    <button
      type='button'
      data-testid='avatar-upload-entry'
      disabled={disabled}
      title={disabledReason ?? label}
      aria-label={disabledReason ?? label}
      onClick={disabled ? undefined : onPick}
      className={cn(
        'group relative block rounded-full outline-none',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
    >
      <UserAvatar name={nickname} src={src} size={size} />
      {/* 覆盖层：默认透明，悬停或键盘聚焦时才出来。aria-hidden —— 语义已经由 button 的 aria-label 承担，
          读屏不该把「替换图像」再念一遍。 */}
      {disabled ? null : (
        <span
          aria-hidden
          className='pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-[12px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100'
        >
          {label}
        </span>
      )}
    </button>
  );
}
