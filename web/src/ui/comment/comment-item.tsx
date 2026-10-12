import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { Username } from '@/ui/user/username';
import { CommentActions } from './comment-actions';
import type { CommentData } from './types';

// 一条评论。**身份部分全部复用 src/ui/user 的控件**（头像/用户名/权限/头衔），
// 动作行复用 CommentActions（它内部复用 Ring UI Button）。这个组件只负责排布。
export function CommentItem({
  comment,
  onLike,
  onDislike,
  onReply,
  avatarSize = 'md',
  className,
  children,
}: {
  comment: CommentData;
  onLike?: () => void;
  onDislike?: () => void;
  onReply?: () => void;
  avatarSize?: 'sm' | 'md';
  className?: string;
  /** 楼中楼或回复框插在这里 */
  children?: ReactNode;
}) {
  const a = comment.author;
  return (
    <article className={cn('flex gap-3', className)}>
      <UserAvatar name={a.nickname} src={a.avatar} size={avatarSize} />
      <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <Username nickname={a.nickname} strong />
          {a.role ? <RoleBadge role={a.role} /> : null}
          {a.title ? <TitleBadge title={a.title} /> : null}
          {comment.op ? (
            <span className='shrink-0 rounded-[4px] bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary'>楼主</span>
          ) : null}
          {comment.mutual ? (
            <span className='shrink-0 rounded-[4px] bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>互相关注</span>
          ) : null}
        </div>
        <p className='text-[14px] leading-relaxed whitespace-pre-wrap text-foreground'>{comment.body}</p>
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
          <span className='text-[12px] tabular-nums text-muted-foreground'>{comment.createdAt}</span>
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
