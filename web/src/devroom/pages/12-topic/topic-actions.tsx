import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Bookmark, Eye, Flag, Heart, Link2, MessageSquare } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 正文下的动作条。点赞/收藏是**唯一的两个可切换状态**（幂等 PUT/DELETE，后端 §21.2），
// 所以只有这两个用 active；分享/举报是一次性动作，用 ghost。
// 计数单独一个 span 包起来（tabular-nums），不要塞进按钮文本里——那样数字一变按钮宽度就跳。
export function TopicActions({
  liked,
  bookmarked,
  likeCount,
  bookmarkCount,
  replyCount,
  viewCount,
  onToggleLike,
  onToggleBookmark,
  onCopyLink,
}: {
  liked: boolean;
  bookmarked: boolean;
  likeCount: number;
  bookmarkCount: number;
  replyCount: number;
  viewCount: number;
  onToggleLike: () => void;
  onToggleBookmark: () => void;
  onCopyLink?: () => void;
}) {
  return (
    <div className='flex flex-wrap items-center gap-1 border-t border-border pt-2 text-muted-foreground'>
      <Button
        ghost
        active={liked}
        icon={icon16(Heart)}
        onClick={onToggleLike}
        aria-label={(liked ? '取消点赞' : '点赞') + '，当前 ' + likeCount + ' 个赞'}
      >
        点赞
      </Button>
      <span className='tabular-nums text-[13px]'>{likeCount}</span>
      <Button
        ghost
        active={bookmarked}
        icon={icon16(Bookmark)}
        onClick={onToggleBookmark}
        aria-label={(bookmarked ? '取消收藏' : '收藏') + '，当前 ' + bookmarkCount + ' 人收藏'}
      >
        收藏
      </Button>
      <span className='tabular-nums text-[13px]'>{bookmarkCount}</span>
      <Button ghost icon={icon16(Link2)} onClick={onCopyLink}>
        分享
      </Button>
      <Button ghost icon={icon16(Flag)}>
        举报
      </Button>
      <span className='ml-auto flex items-center gap-4 text-[12px] text-muted-foreground'>
        <span className='inline-flex items-center gap-1'>
          <MessageSquare aria-hidden className='size-3.5' />
          <span className='tabular-nums'>{replyCount}</span> 回复
        </span>
        <span className='inline-flex items-center gap-1'>
          <Eye aria-hidden className='size-3.5' />
          <span className='tabular-nums'>{viewCount}</span> 浏览
        </span>
      </span>
    </div>
  );
}
