import { Eye, Heart, MessageSquare } from 'lucide-react';
import { formatTime } from '@/lib/format';
import { appPath } from '@/lib/url';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import type { Topic } from './mock';
import { TopicKindTag, TopicMark } from './topic-parts';

// 待提升为 src/ui：**紧凑列表行**（设计需求-分区页 §B2，参考 Discord 消息列表）。
// 规矩：行间不画分割线（靠行距 + hover 底色）；置顶/精华用小标记，不用大色块；
// 元信息弱化——不排成表格，只有回复/赞/浏览三个数字挂在右侧。
export function CompactTopicRow({ topic }: { topic: Topic }) {
  return (
    <article className='group relative flex items-start gap-3 rounded-md px-3 py-2 transition-colors hover:bg-muted/60'>
      <UserAvatar name={topic.author.nickname} src={topic.author.avatar} size='sm' className='mt-0.5' />

      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex min-w-0 items-center gap-2'>
          <a
            href={appPath('t/' + topic.id)}
            className='min-w-0 truncate rounded-[3px] text-[14px] font-medium text-foreground outline-none after:absolute after:inset-0 group-hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            {topic.title}
          </a>
          <TopicMark pinned={topic.pinned} featured={topic.featured_at != null} />
          <TopicKindTag kind={topic.kind} />
          <span className='ml-auto shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums'>
            <Username nickname={topic.author.nickname} size='sm' />
            {' · '}
            {formatTime(topic.last_reply_at)}
          </span>
        </span>
        <p className='m-0 line-clamp-2 text-[12.5px] leading-[1.5] text-muted-foreground'>{topic.excerpt}</p>
      </div>

      <span className='hidden shrink-0 items-center gap-2.5 pt-0.5 text-[11px] text-muted-foreground tabular-nums sm:flex'>
        <span title='回复' className='flex w-10 items-center justify-end gap-0.5'>
          <MessageSquare aria-hidden className='size-3.5' />
          {topic.reply_count}
        </span>
        <span title='点赞' className='flex w-9 items-center justify-end gap-0.5'>
          <Heart aria-hidden className='size-3.5' />
          {topic.like_count}
        </span>
        <span title='浏览' className='flex w-12 items-center justify-end gap-0.5'>
          <Eye aria-hidden className='size-3.5' />
          {topic.view_count}
        </span>
      </span>
    </article>
  );
}
