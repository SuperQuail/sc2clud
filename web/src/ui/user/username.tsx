import { cn } from '@/lib/utils';

// 用户名控件 —— **独立可复用**：主页、帖子、通知、@提及、管理表格都用它。
// 它只渲染「名字」，不负责配色、不负责排版别人（权限与头衔各有自己的控件）。
// 颜色策略：**不按角色给名字上色**。角色由 RoleBadge 用文字表达，颜色只留给头衔（运营在 titles.color 里配）。
const SIZE = { sm: 'text-[13px]', md: 'text-sm', lg: 'text-base', xl: 'text-lg' } as const;

export type UserState = 'active' | 'inactive';

export type UsernameProps = {
  nickname: string;
  /** 登录名（users.username），带上就在名字后加 @handle */
  handle?: string;
  /** inactive = 未激活（users.activated_at 为空）：整名置灰并标注 */
  state?: UserState;
  size?: keyof typeof SIZE;
  /** 需要更强的层级时（例如作者位）加粗，而不是上色 */
  strong?: boolean;
  className?: string;
};

export function Username({ nickname, handle, state = 'active', size = 'md', strong = false, className }: UsernameProps) {
  const inactive = state === 'inactive';
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', SIZE[size], className)}>
      <span
        className={cn(
          'truncate',
          inactive ? 'text-muted-foreground line-through decoration-1' : strong ? 'font-semibold text-foreground' : 'font-medium text-foreground',
        )}
      >
        {nickname}
      </span>
      {handle ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>@{handle}</span> : null}
      {inactive ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>未激活</span> : null}
    </span>
  );
}
