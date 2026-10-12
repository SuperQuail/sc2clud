import { Shield, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UserRole } from './role-badge';

// 用户名控件 —— **独立可复用**：主页、帖子、通知、@提及、作者卡都直接用它。
// 它不假设自己在哪种场景里，也不负责排版别人（头衔、权限各有自己的控件）。
// 三个样式变体是「这一个控件」的候选，不是我针对某个页面做的适配。
const SIZE = { sm: 'text-[13px]', md: 'text-sm', lg: 'text-base', xl: 'text-lg' } as const;

// 角色 → 视觉语气。只有 admin / moderator 有额外强调，其余一律默认色。
const ROLE_TONE: Record<string, { text: string; pill: string; Icon: typeof Shield | null; weight: string }> = {
  admin: { text: 'text-destructive', pill: 'bg-destructive/12 text-destructive', Icon: Shield, weight: 'font-bold' },
  moderator: { text: 'text-primary', pill: 'bg-primary/12 text-primary', Icon: Star, weight: 'font-semibold' },
};

export type UsernameVariant = 'weight' | 'color' | 'pill';

export type UsernameProps = {
  nickname: string;
  handle?: string;
  role?: UserRole | null;
  size?: keyof typeof SIZE;
  /** weight：只靠字重；color：名字着色 + 图标；pill：胶囊高亮 */
  variant?: UsernameVariant;
  className?: string;
};

export function Username({ nickname, handle, role, size = 'md', variant = 'color', className }: UsernameProps) {
  const tone = role ? ROLE_TONE[role.key] : undefined;
  const Icon = variant === 'color' ? tone?.Icon ?? null : null;

  if (variant === 'pill' && tone) {
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1', SIZE[size], className)}>
        <span className={cn('truncate rounded-full px-2 py-0.5 font-semibold', tone.pill)}>{nickname}</span>
        {handle ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>@{handle}</span> : null}
      </span>
    );
  }

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', SIZE[size], className)}>
      <span
        className={cn(
          'truncate',
          variant === 'color' ? tone?.text ?? 'text-foreground' : 'text-foreground',
          variant === 'weight' ? tone?.weight ?? 'font-medium' : variant === 'color' ? 'font-medium' : 'font-medium',
        )}
      >
        {nickname}
      </span>
      {Icon ? <Icon aria-hidden className={cn('size-[0.9em] shrink-0', tone?.text)} /> : null}
      {handle ? <span className='shrink-0 text-[0.85em] text-muted-foreground'>@{handle}</span> : null}
    </span>
  );
}
