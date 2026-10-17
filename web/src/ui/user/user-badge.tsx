import { cn } from '@/lib/utils';
import { UserAvatar, type UserAvatarSize } from './avatar';
import { RoleBadge, type UserRole } from './role-badge';
import { TitleBadge, type UserTitle } from './title-badge';

// 用户渲染控件：**只负责排布**，权限与头衔各自是独立控件（RoleBadge / TitleBadge）。
// 场景不同 → 换 layout / badges 参数，不要重新设计一套。
// 我们没有 level 系统，所以这里没有等级。
export type UserSummary = {
  handle: string;
  nickname: string;
  avatar?: string | null;
  role?: UserRole | null;
  title?: UserTitle | null;
};

export type UserBadgeProps = {
  user: UserSummary;
  size?: UserAvatarSize;
  /** inline：头像在左（列表/回复）；stacked：头像在上（作者卡/个人页） */
  layout?: 'inline' | 'stacked';
  /** 名字后面补 @handle */
  showHandle?: boolean;
  /** 徽标排布：名字前 / 名字后 / 名字下一行 / 不显示 */
  badges?: 'before' | 'after' | 'below' | 'none';
  className?: string;
};

export function UserBadge({
  user,
  size = 'md',
  layout = 'inline',
  showHandle = false,
  badges = 'after',
  className,
}: UserBadgeProps) {
  const stacked = layout === 'stacked';
  const marks = (
    <>
      {user.role ? <RoleBadge role={user.role} /> : null}
      {user.title ? <TitleBadge title={user.title} /> : null}
    </>
  );

  return (
    <span className={cn('flex min-w-0 gap-2', stacked ? 'flex-col items-center text-center' : 'items-center', className)}>
      <UserAvatar name={user.nickname} src={user.avatar} size={size} />
      <span className={cn('flex min-w-0 flex-col gap-0.5', stacked && 'items-center')}>
        <span className={cn('flex min-w-0 items-center gap-1.5', stacked && 'justify-center')}>
          {badges === 'before' ? marks : null}
          <span className='truncate text-sm font-medium text-foreground'>{user.nickname}</span>
          {badges === 'after' ? marks : null}
          {showHandle ? <span className='shrink-0 text-xs text-muted-foreground'>@{user.handle}</span> : null}
        </span>
        {badges === 'below' ? <span className='flex flex-wrap items-center gap-1.5'>{marks}</span> : null}
      </span>
    </span>
  );
}
