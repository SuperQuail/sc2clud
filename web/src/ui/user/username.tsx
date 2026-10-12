import { cn } from '@/lib/utils';
import { RoleBadge, type RoleDesign, type UserRole } from './role-badge';

// 用户名控件 —— 独立可复用，且**权限是它的可选部件**（不是外面再拼一次）。
// 三种挂法由 badge 开关决定：
//   'none'   只显示名字（最干净）
//   'corner' 权限做成**名字右上角的角标**（占位最小，密集列表首选）；角标固定用我们自己的 span ——
//            Ring UI Tag 的文本截断发生在它内部元素上，外层加 max-w-none 压不住（实测截成了「管理…」）
//   'inline' 权限跟在名字后面（作者位、个人主页）
// 颜色：名字可选自定义色；未激活只做暗色。
const SIZE = { sm: 'text-[13px]', md: 'text-sm', lg: 'text-base', xl: 'text-lg' } as const;
export type UsernameBadge = 'none' | 'corner' | 'inline';
export type UserState = 'active' | 'inactive';

export type UsernameProps = {
  nickname: string;
  handle?: string;
  state?: UserState;
  /** 名字的自定义颜色（可选） */
  color?: string | null;
  size?: keyof typeof SIZE;
  strong?: boolean;
  /** 权限挂法开关 */
  badge?: UsernameBadge;
  role?: UserRole | null;
  roleDesign?: RoleDesign;
  className?: string;
};

export function Username({
  nickname,
  handle,
  state = 'active',
  color,
  size = 'md',
  strong = false,
  badge = 'inline',
  role,
  roleDesign,
  className,
}: UsernameProps) {
  const inactive = state === 'inactive';
  const showRole = Boolean(role) && badge !== 'none';
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', SIZE[size], className)}>
      <span
        className={cn('truncate', inactive ? 'text-muted-foreground' : strong ? 'font-semibold' : 'font-medium')}
        style={inactive || !color ? undefined : { color }}
      >
        {nickname}
      </span>
      {showRole && badge === 'corner' ? (
        // 角标：贴名字右上角，小一号、上标对齐；不占额外横向空间，也不影响截断
        <RoleBadge
          role={role!}
          design={roleDesign ?? 2}
          className='-ml-0.5 -translate-y-1.5 max-w-none scale-90 overflow-visible px-1 py-0 text-[9px] leading-[1.5]'
        />
      ) : null}
      {showRole && badge === 'inline' ? <RoleBadge role={role!} design={roleDesign} className='ml-0.5' /> : null}
      {handle ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>@{handle}</span> : null}
    </span>
  );
}
