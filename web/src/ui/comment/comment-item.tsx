import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { Username } from '@/ui/user/username';
import { CommentActions } from './comment-actions';
import { CommentBody } from './comment-body';
import type { CommentData } from './types';

// 一条评论。**主楼与楼中楼必须看得出差别**：靠字号、头像尺寸、间距三处拉开，
// 不是只缩进——之前两者一样大，层级完全读不出来。
const SCALE = {
  top: { gap: 'gap-3', avatar: 'md', name: 'text-[15px]', body: 'text-[15px] leading-[1.7]', meta: 'text-[13px]' },
  reply: { gap: 'gap-2.5', avatar: 'sm', name: 'text-[13px]', body: 'text-[13px] leading-[1.6]', meta: 'text-[12px]' },
} as const;

export function CommentItem({
  comment,
  level = 'top',
  onLike,
  onDislike,
  onReply,
  className,
  children,
}: {
  comment: CommentData;
  /** top = 主楼；reply = 楼中楼 */
  level?: keyof typeof SCALE;
  onLike?: () => void;
  onDislike?: () => void;
  onReply?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const s = SCALE[level];
  const a = comment.author;
  return (
    <article className={cn('flex', s.gap, className)}>
      <UserAvatar name={a.nickname} src={a.avatar} size={s.avatar} />
      <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <Username nickname={a.nickname} className={s.name} strong />
          {a.role ? <RoleBadge role={a.role} /> : null}
          {a.title ? <TitleBadge title={a.title} /> : null}
          {comment.op ? (
            <span className='shrink-0 rounded-[4px] bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary'>楼主</span>
          ) : null}
          {comment.mutual ? (
            <span className='shrink-0 rounded-[4px] bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>互相关注</span>
          ) : null}
        </div>
        <CommentBody body={comment.body} className={cn('whitespace-pre-wrap text-foreground', s.body)} />
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
          <span className={cn('tabular-nums text-muted-foreground', s.meta)}>{comment.createdAt}</span>
          <CommentActions
            likes={comment.likes}
            dislikes={comment.dislikes}
            liked={comment.liked}
            disliked={comment.disliked}
            onLike={onLike}
            onDislike={onDislike}
            onReply={onReply}
          />
        </div>
        {children}
      </div>
    </article>
  );
}
