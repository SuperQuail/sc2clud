import type { ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Flag, Trash2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { CommentActions } from '@/ui/comment/comment-actions';
import { CommentBody } from '@/ui/comment/comment-body';
import { UserAvatar } from '@/ui/user/avatar';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { Username } from '@/ui/user/username';
import type { CommentData } from '@/ui/comment/types';

// 帖子页评论区比 08 样板间多两件事：**删掉自己的回复**、**举报某条回复**。
// 这两件事为什么不加进 src/ui/comment：
//   ① 删帖 / 删回复是**两个动作**（权限点、影响面、二次确认都不一样）——
//      管理侧本来就分开（帖子级 post.delete_any 与回复级各自处理），评论区不该糊成一个「删除」；
//   ② 举报要弹层、要有已举报态，弹层归帖子页（它才知道 target_type/target_id），
//      动作条只该摆位置。
// 所以这里包一层：**排版照抄 CommentItem**（同一套字号/头像档位/间距），
// 只把动作行换成「原地那一行 + 右侧两个悬挂动作」。复制这几行是为了不动共享控件的 props。
const SCALE = {
  top: { gap: 'gap-3', avatar: 'md', name: 'text-[15px]', body: 'text-[15px] leading-[1.7]', meta: 'text-[13px]' },
  reply: { gap: 'gap-2.5', avatar: 'sm', name: 'text-[13px]', body: 'text-[13px] leading-[1.6]', meta: 'text-[12px]' },
} as const;

export function CommentActionsRow({
  comment,
  level = 'top',
  mine = false,
  reported = false,
  onLike,
  onDislike,
  onReply,
  onDelete,
  onReport,
  children,
}: {
  comment: CommentData;
  /** top = 主楼；reply = 楼中楼 */
  level?: keyof typeof SCALE;
  /** 这条是不是我写的：是才给「删除」（删帖与删回复分开，这里只做删回复） */
  mine?: boolean;
  reported?: boolean;
  onLike?: () => void;
  onDislike?: () => void;
  onReply?: () => void;
  onDelete?: () => void;
  onReport?: () => void;
  /** 楼中楼 / 内联回复框从这个槽位挂进来 */
  children?: ReactNode;
}) {
  const s = SCALE[level];
  const a = comment.author;
  return (
    <article className={'flex ' + s.gap}>
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
        <CommentBody
          body={comment.body}
          collapsible={level === 'top'}
          collapsedHeight={180}
          className={'text-foreground ' + s.body}
        />
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
          <span className={'tabular-nums text-muted-foreground ' + s.meta}>{comment.createdAt}</span>
          <CommentActions
            likes={comment.likes}
            dislikes={comment.dislikes}
            liked={comment.liked}
            disliked={comment.disliked}
            onLike={onLike}
            onDislike={onDislike}
            onReply={onReply}
          />
          {mine || onReport ? (
            <span className='flex items-center gap-1'>
              {mine ? <RowAction icon={Trash2} label='删除' aria={deletedAria(comment)} testId='comment-delete' onClick={onDelete} /> : null}
              {onReport ? (
                <RowAction
                  icon={Flag}
                  label={reported ? '已举报' : '举报'}
                  aria={reported ? '已举报这条回复' : '举报这条回复'}
                  testId='comment-report'
                  active={reported}
                  onClick={onReport}
                />
              ) : null}
            </span>
          ) : null}
        </div>
        {children}
      </div>
    </article>
  );
}

/** 悬挂动作的形状：ghost + S 档（24px，与评论区其它动作同档）+ icon16。
 *  不显式 inline={false} 的话热区只有 16×16（Ring 的 Button 带 icon 就默认 inline）。 */
function RowAction({
  icon,
  label,
  aria,
  testId,
  active,
  onClick,
}: {
  icon: typeof Flag;
  label: string;
  aria: string;
  testId: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      inline={false}
      height={ControlsHeight.S}
      ghost
      active={active}
      icon={icon16(icon)}
      aria-label={aria}
      data-testid={testId}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

/** 删除按钮的读屏名要能认出是哪一条，不然一屏里 8 个「删除」长得一模一样。 */
function deletedAria(comment: CommentData): string {
  return '删除我的这条回复：' + comment.body.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 16);
}

/** 自己的回复被删掉之后占的位置。**不整行消失**：整行消失会让人以为「刚才看错了」，
 *  真实后端也是软删（正文变成「该回复已删除」）。 */
export function DeletedCommentItem({ comment }: { comment: CommentData }) {
  return (
    <article className='flex gap-3'>
      <UserAvatar name='已删除' src={null} size='md' />
      <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
        <Username nickname='已删除用户' className='text-[15px]' />
        <span className='text-[15px] leading-[1.7] text-muted-foreground'>该回复已删除。</span>
        <span className='tabular-nums text-[13px] text-muted-foreground'>{comment.createdAt}</span>
      </div>
    </article>
  );
}
