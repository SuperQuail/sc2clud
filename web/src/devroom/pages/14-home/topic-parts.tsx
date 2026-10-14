import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { KIND_TAG, KIND_TINT, TOPIC_KIND_LABEL } from './topic-kind';
import type { Topic, TopicKind } from './mock';

// 待提升为 src/ui：帖子卡片族（方卡片 + 封面 + 标记），业务无关，只吃 props。
// 提升时要一起带走的：topic-kind.ts（文案/配色映射）+ 本文件的 TopicCover（16:9 容器 + 无封面占位）。

// 封面位宽 256 逻辑像素（1440 视口四列时），源图比这还小、放大出来就是糊的。
// 宁可回落成占位块，也不要一张糊图：阈值留了余量，高 DPI 下也不至于裂。
const MIN_COVER_WIDTH = 320;

/** 16:9 封面容器：固定宽高比 → 有图无图都不跳版（CLS ≤ 0.1 的硬前提）。 */
export function TopicCover({ topic, className }: { topic: Topic; className?: string }) {
  // 图太小就退回占位块。两条判据，**先看后端给的尺寸**（J9）：
  //   ① cover_width/cover_height 是列表响应自带的（TopicCardDTO），有它就**不用发那次图片请求**，
  //      也不会有「先闪一张糊图、解码完再换成占位块」的那一跳；
  //   ② 没有那两个字段时（旧数据、或接口没给）才退回在解码后量 naturalWidth —— 保底路径不变。
  const declaredTooSmall =
    typeof topic.cover_width === 'number' && topic.cover_width > 0 && topic.cover_width < MIN_COVER_WIDTH;
  const [tooSmall, setTooSmall] = useState(false);
  const usable = Boolean(topic.cover) && !declaredTooSmall && !tooSmall;
  return (
    <div className={cn('relative aspect-video w-full overflow-hidden bg-muted', className)}>
      {usable ? (
        <img
          src={topic.cover ?? ''}
          alt={'《' + topic.title + '》封面'}
          loading='lazy'
          decoding='async'
          ref={(el) => {
            if (el && el.complete && el.naturalWidth > 0 && el.naturalWidth < MIN_COVER_WIDTH) setTooSmall(true);
          }}
          onError={() => setTooSmall(true)}
          className='absolute inset-0 size-full object-cover'
        />
      ) : (
        // 无封面：色块 + 分区首字（首字比纯色块好认，也比默认占位图干净）
        <span
          aria-hidden
          className={cn('absolute inset-0 flex items-center justify-center bg-gradient-to-br to-transparent', KIND_TINT[topic.kind])}
        >
          <span className='text-[40px] leading-none font-semibold text-foreground/25'>{[...topic.board.name][0] ?? '?'}</span>
        </span>
      )}
    </div>
  );
}

/** 置顶 / 精华标记：小、带底色、不抢标题。 */
export function TopicMark({ pinned, featured }: { pinned?: boolean; featured?: boolean }) {
  if (!pinned && !featured) return null;
  const cls = 'px-0.5 py-0 text-[10px] leading-[1.4] font-medium';
  return (
    <span className='flex shrink-0 items-center gap-1'>
      {pinned ? (
        <Tag tagType={TagType.WARNING} className={cls}>
          置顶
        </Tag>
      ) : null}
      {featured ? (
        <Tag tagType={TagType.SUCCESS} outline className={cls}>
          精华
        </Tag>
      ) : null}
    </span>
  );
}

/** 类型徽标（讨论 / 资源 / 转载）。 */
export function TopicKindTag({ kind, className }: { kind: TopicKind; className?: string }) {
  return (
    <Tag tagType={KIND_TAG[kind]} className={cn('shrink-0 px-1 py-0 text-[11px] leading-[1.6]', className)}>
      {TOPIC_KIND_LABEL[kind]}
    </Tag>
  );
}