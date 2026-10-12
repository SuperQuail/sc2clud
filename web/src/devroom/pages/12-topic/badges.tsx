import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { BadgeCheck, Flame, Pin, Repeat } from 'lucide-react';
import type { TopicKind } from './types';

// 帖子上的小标记。这不是新控件，是把「Tag + 颜色 + 图标」的固定组合收成一处，
// 免得在标题、列表、反馈卡片里各写一遍同样的映射。
// 图标是 Tag 的 children（普通 HTML），不经过 Ring 的 icon prop，所以不需要 icon16 包装。

const KIND: Record<TopicKind, { label: string; type: TagType }> = {
  discussion: { label: '讨论', type: TagType.DEFAULT },
  resource: { label: '资源', type: TagType.MAIN },
  repost: { label: '转载', type: TagType.PURPLE },
};

export function KindTag({ kind }: { kind: TopicKind }) {
  const k = KIND[kind];
  return <Tag tagType={k.type}>{k.label}</Tag>;
}

export function PinnedFlag() {
  return (
    <span className='inline-flex items-center gap-1 rounded-[4px] bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground'>
      <Pin aria-hidden className='size-3' />
      置顶
    </span>
  );
}

export function FeaturedFlag() {
  return (
    <span className='inline-flex items-center gap-1 rounded-[4px] bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary'>
      <Flame aria-hidden className='size-3' />
      精华
    </span>
  );
}

export function SolvedFlag({ label = '已解决' }: { label?: string }) {
  return (
    <span className='inline-flex items-center gap-1 rounded-[4px] bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground'>
      <BadgeCheck aria-hidden className='size-3' />
      {label}
    </span>
  );
}

export function RepostSource({ from }: { from: string }) {
  return (
    <span className='inline-flex items-center gap-1 text-[12px] text-muted-foreground'>
      <Repeat aria-hidden className='size-3' />
      转载自 {from}
    </span>
  );
}
