import { Clock, Eye, Heart, MessageSquare } from 'lucide-react';
import { formatTime } from '@/lib/format';
import { appPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import type { Topic } from './mock';
import { TopicCover, TopicKindTag, TopicMark } from './topic-parts';

// 待提升为 src/ui：**方卡片**（设计需求-分区页 §B1）。一行 ≥4 张的硬指标靠调用方的 grid 保证，
// 卡片自身只用 w-full + aspect-video：宽度由栅格给，卡片不写死尺寸。
//
// 可访问性：整卡可点用「标题链接 + after:absolute after:inset-0」的拉伸命中区实现——
// 只留两个 Tab 停靠点（标题、作者），不给卡片加 tabIndex，也不用 div 包 onClick。
export function SquareTopicCard({ topic, className }: { topic: Topic; className?: string }) {
  const time = formatTime(topic.last_reply_at);
  return (
    <article
      data-testid={'sq-card-' + topic.id}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/40 hover:bg-accent',
        className,
      )}
    >
      <TopicCover topic={topic} />

      <div className='flex min-w-0 flex-1 flex-col gap-2 p-3'>
        <span className='flex items-center gap-1.5'>
          <TopicKindTag kind={topic.kind} />
          <TopicMark pinned={topic.pinned} featured={topic.featured_at != null} />
        </span>

        <h3 className='m-0 text-[14px] leading-[1.4] font-medium text-foreground'>
          <a
            href={appPath('t/' + topic.id)}
            className='line-clamp-2 rounded-[3px] outline-none after:absolute after:inset-0 group-hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            {topic.title}
          </a>
        </h3>

        {/* 作者行单独抬到拉伸命中区之上，点得到（z-10） */}
        <a
          href={appPath('u/' + topic.author.handle)}
          className='relative z-10 flex min-w-0 items-center gap-1.5 rounded-[3px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
        >
          <UserAvatar name={topic.author.nickname} src={topic.author.avatar} size='sm' />
          <Username nickname={topic.author.nickname} size='sm' />
        </a>

        <span className='mt-auto flex items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums'>
          <span title='回复' className='flex items-center gap-0.5'>
            <MessageSquare aria-hidden className='size-3.5' />
            {topic.reply_count}
          </span>
          <span title='点赞' className='flex items-center gap-0.5'>
            <Heart aria-hidden className='size-3.5' />
            {topic.like_count}
          </span>
          <span title='浏览' className='flex items-center gap-0.5'>
            <Eye aria-hidden className='size-3.5' />
            {topic.view_count}
          </span>
          <span className='flex shrink-0 items-center gap-0.5 whitespace-nowrap'>
            <Clock aria-hidden className='size-3.5' />
            {time}
          </span>
        </span>
      </div>
    </article>
  );
}