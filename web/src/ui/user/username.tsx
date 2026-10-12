import { cn } from '@/lib/utils';

// 用户名控件 —— **独立可复用**：主页、帖子、通知、@提及、管理表格都用它。
// 只渲染名字；不负责排版别人（权限、头衔各有自己的控件）。
// 颜色：**可选且由调用方给**（例如角色的配色字段）。不传就是默认前景色。
// 未激活：**只是暗色**，不加文字标记、不加横线。
const SIZE = { sm: 'text-[13px]', md: 'text-sm', lg: 'text-base', xl: 'text-lg' } as const;

export type UserState = 'active' | 'inactive';

export type UsernameProps = {
  nickname: string;
  handle?: string;
  /** inactive：整名变暗即可（users.activated_at 为空） */
  state?: UserState;
  /** 自定义颜色（可选）；不传用默认前景色 */
  color?: string | null;
  size?: keyof typeof SIZE;
  /** 需要更强层级时加粗（作者位） */
  strong?: boolean;
  className?: string;
};

export function Username({
  nickname,
  handle,
  state = 'active',
  color,
  size = 'md',
  strong = false,
  className,
}: UsernameProps) {
  const inactive = state === 'inactive';
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', SIZE[size], className)}>
      <span
        className={cn('truncate', inactive ? 'text-muted-foreground' : strong ? 'font-semibold' : 'font-medium')}
        style={inactive || !color ? undefined : { color }}
      >
        {nickname}
      </span>
      {handle ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>@{handle}</span> : null}
    </span>
  );
}
