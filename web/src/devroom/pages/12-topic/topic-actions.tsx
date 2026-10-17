import type { ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Bookmark, Eye, Flag, Heart, Link2, Lock, MessageSquare, Pencil, Pin, Sparkles, Trash2 } from 'lucide-react';
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
  /** 编辑走**发帖页**（用户 2026-10-15：编辑不应是帖内小弹层）——宿主注入跳转地址，不给就不渲染 */
  editHref,
  /** 删帖：设计稿里没有这一颗，但「发错了删不掉」是盲测报过的缺陷——所以留着，由宿主决定给不给 */
  onDelete,
  /** 版主的两颗开关（D73）：宿主给整组就画，不给（房间不传）就整组不渲染 */
  pinOn,
  featureOn,
  pinPending,
  onTogglePin,
  onToggleFeature,
  /** 锁定（D73 的同款第三颗；权限点 topic.lock，与置顶/精华不是同一个）：不给就不渲染这一颗 */
  lockOn,
  lockPending,
  onToggleLock,
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
  /** 不给就不渲染「编辑」；给出 = 点它去发帖页的编辑态（room: ?page=18-compose&edit=…，产品: /new?edit=…） */
  editHref?: string;
  /** 不给就不渲染「删除」 */
  onDelete?: () => void;
  /** 版主的两颗开关（D73，端点族 POST /topics/{id}/pin|feature，权限点 topic.pin）：
   *  pinOn / featureOn 是详情里的当前值（开关亮不亮）；回调是宿主给的端口，不给就不渲染那一颗 */
  pinOn?: boolean;
  featureOn?: boolean;
  /** 置顶请求在途：只禁置顶那一颗，别为它多造一层等待态 */
  pinPending?: boolean;
  /** 点击上行的是 !current */
  onTogglePin?: (next: boolean) => void;
  onToggleFeature?: (next: boolean) => void;
  /** 已锁定（topic.locked）；文案与选中态都由它决定：未锁读「锁定」、已锁读「解锁」 */
  lockOn?: boolean;
  lockPending?: boolean;
  onToggleLock?: (next: boolean) => void;
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
        {editHref ? (
          <Button
            ghost
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(Pencil)}
            aria-label='编辑这篇帖子'
            data-testid='topic-edit'
            href={editHref}
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
        {onTogglePin ? (
          <Button
            ghost
            inline={false}
            height={ControlsHeight.S}
            active={pinOn}
            disabled={pinPending}
            icon={icon16(Pin)}
            aria-label={pinOn ? '取消置顶' : '置顶这篇帖子'}
            data-testid='topic-pin-toggle'
            onClick={() => onTogglePin(!pinOn)}
          >
            置顶
          </Button>
        ) : null}
        {onToggleFeature ? (
          <Button
            ghost
            inline={false}
            height={ControlsHeight.S}
            active={featureOn}
            icon={icon16(Sparkles)}
            aria-label={featureOn ? '取消精华' : '设为精华'}
            data-testid='topic-feature-toggle'
            onClick={() => onToggleFeature(!featureOn)}
          >
            精华
          </Button>
        ) : null}
        {onToggleLock ? (
          <Button
            ghost
            inline={false}
            height={ControlsHeight.S}
            active={lockOn}
            disabled={lockPending}
            icon={icon16(Lock)}
            // 文案跟着状态走（未锁读「锁定」、已锁读「解锁」）：只写「锁定」的话，
            // 已锁的帖子上那颗按钮读起来像「再锁一次」，人不敢点。
            aria-label={lockOn ? '解除锁定' : '锁定这篇帖子（锁定后不能再回复）'}
            data-testid='topic-lock-toggle'
            onClick={() => onToggleLock(!lockOn)}
          >
            {lockOn ? '解锁' : '锁定'}
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
