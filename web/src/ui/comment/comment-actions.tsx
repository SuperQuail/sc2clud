import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 一条评论的动作行。三件事都是动作，所以**复用 Ring UI Button**（ghost 变体），
// 不手写 <button>——这是 DevRoom 里定下的规矩，也是为了键盘/焦点行为一致。
//
// **三个按钮都显式 inline={false}**：Ring 的 Button 只要带 icon 就默认 inline
// （isInline = inline ?? text ?? !!icon），而 .ring-button-inline 是 padding:0 —— 命中区紧贴文字边缘
// （实测点赞 36x24、回复 48x24，四周没有内边距）。这不是「高度不够」的问题，所以判据是
// **只要会渲染文字就收口**：inline={false} + S 档（24px，与原高度一致，不会撑高评论头行）。
// 变体保持 ghost（透明底、无边框）：这是一排次要动作，只加内边距、不改观感。
// 特例：点踩在计数为 0 时文字为空 —— 加 inline={false} 后两种状态的命中区都是 24x24。
// J3（拍板）：踩数只对管理员以上与内容作者下发。拿不到数字时那一格回答的是「**我自己**点没点」
// ——选中态来自 my_vote（调用方换算成 disliked），可读名也跟着说「取消点踩」；数字一个都不占。
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
  /** 拿不到（undefined）就**不渲染数字**：那是「后端按身份没下发」，不是「0 个踩」。 */
  dislikes?: number;
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
        inline={false}
        height={ControlsHeight.S}
        ghost
        icon={icon16(ThumbsUp)}
        active={liked}
        onClick={onLike}
        aria-label={'点赞，当前 ' + likes + ' 个赞'}
      >
        <span className='tabular-nums'>{likes || '赞'}</span>
      </Button>
      <Button
        inline={false}
        height={ControlsHeight.S}
        ghost
        icon={icon16(ThumbsDown)}
        active={disliked}
        onClick={onDislike}
        // 与点赞那颗同一个写法：可读名说清「这一下是投还是取消」，非特权用户就靠它知道自己的投票态
        aria-label={disliked ? '取消点踩' : '点踩'}
      >
        {typeof dislikes === 'number' ? <span className='tabular-nums'>{dislikes || ''}</span> : null}
      </Button>
      <Button inline={false} height={ControlsHeight.S} ghost icon={icon16(MessageSquare)} onClick={onReply}>
        {replyLabel}
      </Button>
    </span>
  );
}
