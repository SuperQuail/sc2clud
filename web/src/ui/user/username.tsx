import { cn } from '@/lib/utils';
import { roleColor, type RoleLike } from './role-color';

// 用户名控件 —— **独立可复用**：主页、帖子、通知、@提及、管理表格都直接用它。
// 它不假设自己在哪种场景、不负责排版别人（权限与头衔各有自己的控件）。
// 三个样式变体是「这一个控件」的候选；**没有图标/emoji**。
// 角色只影响颜色，且颜色由 key 派生——权限树变了不用改这里。
const SIZE = { sm: 'text-[13px]', md: 'text-sm', lg: 'text-base', xl: 'text-lg' } as const;

export type UsernameVariant = 'weight' | 'color' | 'pill';
export type UserState = 'active' | 'inactive';

export type UsernameProps = {
  nickname: string;
  handle?: string;
  /** 主要角色（决定颜色）。多角色时由使用方挑一个上色 */
  role?: RoleLike | null;
  /** inactive = 未激活：整名置灰并标注 */
  state?: UserState;
  size?: keyof typeof SIZE;
  /** weight：只靠字重；color：名字着色；pill：胶囊高亮 */
  variant?: UsernameVariant;
  className?: string;
};

export function Username({
  nickname,
  handle,
  role,
  state = 'active',
  size = 'md',
  variant = 'color',
  className,
}: UsernameProps) {
  const inactive = state === 'inactive';
  const c = inactive ? undefined : role ? roleColor(role.key, role.color) : undefined;

  if (variant === 'pill' && c) {
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1', SIZE[size], className)}>
        <span
          className='truncate rounded-full px-2 py-0.5 font-semibold'
          style={{ color: c, backgroundColor: 'color-mix(in srgb, ' + c + ' 14%, transparent)' }}
        >
          {nickname}
        </span>
        {handle ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>@{handle}</span> : null}
      </span>
    );
  }

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', SIZE[size], className)}>
      <span
        className={cn(
          'truncate',
          inactive && 'text-muted-foreground line-through decoration-1',
          !inactive && variant === 'weight' && 'font-semibold text-foreground',
          !inactive && variant === 'color' && 'font-medium',
        )}
        style={c ? { color: c } : undefined}
      >
        {nickname}
      </span>
      {handle ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>@{handle}</span> : null}
      {inactive ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>未激活</span> : null}
    </span>
  );
}
