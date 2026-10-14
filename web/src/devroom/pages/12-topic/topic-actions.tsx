import type { ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Bookmark, Eye, Flag, Heart, Link2, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 正文下的动作条。**每个动作都必须有可观察的结果**（缺陷处理总纲 §7）：
//   点赞/收藏 = 唯一的两个可切换状态（幂等 PUT/DELETE，后端 §21.2）；
//   分享     = 复制链接 + 一行回执（原来点了没反应）；
//   举报     = 打开举报弹层；提交后本按钮变「已举报」；
//   编辑     = 打开编辑弹层（权限点 post.update_own，后端 v2 §21.2 的 PATCH /api/v1/topics/{id}）。
// 每个动作都是 icon+文字，**必须显式 inline={false}**：不然 Ring UI 按 inline 排（padding 0，
// 实测点击区只有 48x24），改成 block + height S 后 32px 高。填充仍是透明（ghost），观感还是一排文字动作。
// 计数单独一个 span 包起来（tabular-nums），不要塞进按钮文本里——那样数字一变按钮宽度就跳。
export function TopicActions({
  liked,
  bookmarked,
  likeCount,
  bookmarkCount,
  replyCount,
  viewCount,
  reported,
  onToggleLike,
  onToggleBookmark,
  onCopyLink,
  onReport,
  onEdit,
  /** 删帖：设计稿里没有这一颗，但「发错了删不掉」是盲测报过的缺陷——所以留着，由宿主决定给不给 */
  onDelete,
  /** 设计稿反馈那一行：由页面插在动作条下面 */
  designNote,
  /** 删除确认（受控）：贴着删除按钮出现，别让人滚到页尾去找 */
  deleteConfirm,
}: {
  liked: boolean;
  bookmarked: boolean;
  likeCount: number;
  /** 收藏数：后端详情不回这个数（dto.go 的 TopicDetailDTO 里没有），拿不到就不显示这一格数字，
   *  不写一个会骗人的 0 */
  bookmarkCount?: number;
  replyCount: number;
  viewCount: number;
  reported: boolean;
  onToggleLike?: () => void;
  onToggleBookmark?: () => void;
  onCopyLink?: () => void;
  onReport?: () => void;
  /** 不给就不渲染「编辑」（不是作者、或没有 topic.edit.own） */
  onEdit?: () => void;
  /** 不给就不渲染「删除」 */
  onDelete?: () => void;
  designNote?: ReactNode;
  deleteConfirm?: ReactNode;
}) {
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex flex-wrap items-center gap-1 border-t border-border pt-2 text-muted-foreground'>
        <Button
          ghost
          inline={false}
          height={ControlsHeight.S}
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
          inline={false}
          height={ControlsHeight.S}
          active={bookmarked}
          icon={icon16(Bookmark)}
          onClick={onToggleBookmark}
          aria-label={(bookmarked ? '取消收藏' : '收藏') + '，当前 ' + bookmarkCount + ' 人收藏'}
        >
          收藏
        </Button>
        {bookmarkCount != null ? <span className='tabular-nums text-[13px]'>{bookmarkCount}</span> : null}
        <Button ghost inline={false} height={ControlsHeight.S} icon={icon16(Link2)} onClick={onCopyLink}>
          分享
        </Button>
        <Button
          ghost
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(Flag)}
          active={reported}
          aria-label={reported ? '已举报这篇帖子' : '举报这篇帖子'}
          data-testid='topic-report'
          onClick={onReport}
        >
          {reported ? '已举报' : '举报'}
        </Button>
        {onEdit ? (
          <Button
            ghost
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(Pencil)}
            aria-label='编辑这篇帖子'
            data-testid='topic-edit'
            onClick={onEdit}
          >
            编辑
          </Button>
        ) : null}
        {onDelete ? (
          <Button
            ghost
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(Trash2)}
            aria-label='删除这篇帖子'
            data-testid='topic-delete'
            onClick={onDelete}
          >
            删除
          </Button>
        ) : null}
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
      {deleteConfirm}
      {designNote}
    </div>
  );
}
