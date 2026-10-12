import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// 设计语言 B（用户向）：颜色鲜艳、按钮大、圆润。
// 用在普通访客看得到的地方（首页 / 分区页 / 帖子页）；发帖页与管理页用设计语言 A（Ring UI）。
// 这里是 src/ui，所以允许直接写 <button> —— 业务代码不许手写（gate:ui 会挡）。
const vivid = cva(
  [
    'inline-flex select-none items-center justify-center gap-2 font-semibold',
    'outline-none transition-[background-color,box-shadow,transform] duration-150',
    'focus-visible:ring-[3px] focus-visible:ring-ring/40',
    'active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
    'motion-reduce:transition-none motion-reduce:active:translate-y-0',
  ].join(' '),
  {
    variants: {
      tone: {
        primary: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110',
        accent: 'bg-[var(--vivid-accent)] text-white shadow-sm hover:brightness-110',
        soft: 'bg-primary/12 text-primary hover:bg-primary/20',
        ghost: 'text-foreground/80 hover:bg-foreground/6 hover:text-foreground',
        danger: 'bg-destructive text-destructive-foreground shadow-sm hover:brightness-110',
      },
      size: {
        md: 'h-10 rounded-full px-5 text-[15px]',
        lg: 'h-12 rounded-full px-7 text-base',
        icon: 'size-11 rounded-full',
      },
    },
    defaultVariants: { tone: 'primary', size: 'md' },
  },
);

export type VividButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof vivid> & {
    /** 图标：lucide 组件；这里是我们自己的控件，所以直接传，不需要 Ring UI 的尺寸包装 */
    icon?: LucideIcon;
    loading?: boolean;
    /** 下拉触发器：右侧显示箭头（对齐 Ring UI Button 的 dropdown） */
    dropdown?: boolean;
  };

export function VividButton({
  className,
  tone,
  size,
  icon: Icon,
  loading = false,
  dropdown = false,
  disabled,
  children,
  ...props
}: VividButtonProps) {
  return (
    <button
      type={props.type ?? 'button'}
      className={cn(vivid({ tone, size }), loading && 'vivid-loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <Loader2 aria-hidden className='size-5 animate-spin' />
      ) : Icon ? (
        <Icon aria-hidden className='size-5' />
      ) : null}
      {children}
      {dropdown ? (
        <span
          aria-hidden
          className='ml-0.5 size-0 border-x-[4px] border-t-[5px] border-x-transparent border-t-current opacity-70'
        />
      ) : null}
    </button>
  );
}
