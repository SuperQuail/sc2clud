import Button from '@jetbrains/ring-ui-built/components/button/button';
import { MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 一条评论的动作行。三件事都是动作，所以**复用 Ring UI Button**（ghost 变体），
// 不手写 <button>——这是 DevRoom 里定下的规矩，也是为了键盘/焦点行为一致。
export function CommentActions({
  likes,
  dislikes,
  liked = false,
  disliked = false,
  onLike,
  onDislike,
  onReply,
  replyLabel = '回复',
}: {
  likes: number;
  dislikes: number;
  liked?: boolean;
  disliked?: boolean;
  onLike?: () => void;
  onDislike?: () => void;
  onReply?: () => void;
  replyLabel?: string;
}) {
  return (
    <span className='flex items-center gap-1 text-muted-foreground'>
      <Button
        ghost
        icon={icon16(ThumbsUp)}
        active={liked}
        onClick={onLike}
        aria-label={'点赞，当前 ' + likes + ' 个赞'}
      >
        <span className='tabular-nums'>{likes || '赞'}</span>
      </Button>
      <Button ghost icon={icon16(ThumbsDown)} active={disliked} onClick={onDislike} aria-label='点踩'>
        <span className='tabular-nums'>{dislikes || ''}</span>
      </Button>
      <Button ghost icon={icon16(MessageSquare)} onClick={onReply}>
        {replyLabel}
      </Button>
    </span>
  );
}
