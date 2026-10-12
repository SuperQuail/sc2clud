import Avatar from '@jetbrains/ring-ui-built/components/avatar/avatar';
import { cn } from '@/lib/utils';

// 统一的用户渲染控件：头像 + 昵称 + 权限等级 + 头衔。
// 为什么在 src/ui 而不是就地写：全站（帖子作者、回复、私信、通知、后台）都要同一套渲染，
// 而且 Ring UI 的 Avatar 只认固定尺寸、alt 写死英文——这两点必须在这里一次性收口（开发必读 §2）。
export type UserTitle = { name: string; color?: string | null };
export type UserRole = { key: string; name: string };

export type UserSummary = {
  handle: string;
  nickname: string;
  avatar?: string | null;
  level?: number | null;
  role?: UserRole | null;
  title?: UserTitle | null;
};

// Ring UI Avatar 的 fallback 只认这几个尺寸，传别的会抛 TypeError
const AVATAR_PX = { sm: 24, md: 32, lg: 40 } as const;
export type UserBadgeSize = keyof typeof AVATAR_PX;

export type UserBadgeProps = {
  user: UserSummary;
  size?: UserBadgeSize;
  /** stacked = 头像在上、信息在下（帖子详情右栏用） */
  layout?: 'inline' | 'stacked';
  /** 名字后面是否带 @handle */
  showHandle?: boolean;
  className?: string;
};

export function UserBadge({ user, size = 'md', layout = 'inline', showHandle = false, className }: UserBadgeProps) {
  const stacked = layout === 'stacked';
  return (
    <span
      className={cn('flex min-w-0 gap-2', stacked ? 'flex-col items-center text-center' : 'items-center', className)}
    >
      {/* 头像对辅助技术是装饰性的：语义由旁边可读的名字承载（也绕开 Ring UI 写死的英文 alt） */}
      <Avatar
        size={AVATAR_PX[size]}
        url={user.avatar ?? undefined}
        // 只给首字：Ring UI 的 fallback 会把它画成可见文字，给全名就会与旁边的昵称重复
        username={[...user.nickname][0] ?? user.handle}
        alt=''
        className='shrink-0'
      />
      <span className={cn('flex min-w-0 flex-col', stacked && 'items-center')}>
        <span className='flex min-w-0 items-center gap-1.5'>
          <span className='truncate text-sm font-medium text-foreground'>{user.nickname}</span>
          {typeof user.level === 'number' ? (
            <span
              className='shrink-0 rounded-sm bg-primary/12 px-1 text-[11px] font-medium text-primary tabular-nums'
              title={'等级 ' + user.level}
            >
              Lv.{user.level}
            </span>
          ) : null}
        </span>
        {user.role || user.title ? (
          <span className='flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
            {user.role ? <span className='truncate'>{user.role.name}</span> : null}
            {user.title ? (
              <span
                className='truncate rounded-sm px-1.5 font-medium'
                style={{
                  color: user.title.color ?? 'var(--primary)',
                  backgroundColor: 'color-mix(in srgb, ' + (user.title.color ?? 'var(--primary)') + ' 12%, transparent)',
                }}
              >
                {user.title.name}
              </span>
            ) : null}
          </span>
        ) : null}
        {showHandle ? <span className='truncate text-xs text-muted-foreground'>@{user.handle}</span> : null}
      </span>
    </span>
  );
}
