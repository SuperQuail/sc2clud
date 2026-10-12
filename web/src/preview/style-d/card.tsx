// 方向 D / 卡片视图 B1：两个变体各一套卡形（v1 竖卡铺封面，v2 横卡排两列）。
// 硬指标：1440×900 扣掉顶栏与分区头后，完整可见的卡片 ≥4 张（每套都是 2 行 × 列数）。
import { MessageSquare, Star } from 'lucide-react';
import { Bar, Kind, Marks, Metrics, User } from './bits';
import { boardOf, relative, type Topic } from './data';
import { NoCover, TopicCover } from './art';

/* ── v1「封面主导竖卡」 ─────────────────────────────────────────────────── */

export function CardV1({ topic, now }: { topic: Topic; now: number }) {
  return (
    <article className='group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/50'>
      {topic.cover ? (
        <TopicCover className='relative aspect-[16/9] w-full rounded-none' kind='mesh' title={topic.title} topicId={topic.id} />
      ) : (
        <NoCover className='aspect-[16/9] w-full' />
      )}
      <div className='flex flex-1 flex-col gap-2.5 p-4 sm:p-[1.15rem]'>
        <div className='flex items-center gap-2 text-[12px] text-muted-foreground'>
          <a className='font-medium text-foreground hover:underline' href={'#/b/' + boardOf(topic).slug}>
            {boardOf(topic).name}
          </a>
          <span aria-hidden>·</span>
          <span className='tabular-nums'>最后回复 {relative(topic.last_reply_at, now)}</span>
          <Marks topic={topic} />
        </div>

        <h3 className='text-[16.5px] leading-[1.4] font-semibold tracking-[-0.01em] text-foreground'>
          <a className='outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50' href={'#/t/' + topic.id}>
            {topic.title}
          </a>
        </h3>

        <p className='line-clamp-2 text-[13.5px] leading-[1.7] text-muted-foreground'>{topic.excerpt}</p>

        <div className='mt-auto flex items-center gap-2.5 pt-3'>
          <User nickname={topic.author.nickname} size={24} />
          <span className='truncate text-[12.5px] text-foreground'>{topic.author.nickname}</span>
          <Kind kind={topic.kind} strong />
          <Metrics className='ml-auto shrink-0' topic={topic} />
        </div>
      </div>
    </article>
  );
}

export function CardV1Skeleton() {
  return (
    <div aria-hidden className='flex flex-col overflow-hidden rounded-lg border border-border bg-card'>
      <Bar className='aspect-[16/9] w-full rounded-none' />
      <div className='flex flex-col gap-3 p-4 sm:p-[1.15rem]'>
        <Bar className='h-3 w-32' />
        <Bar className='h-4 w-11/12' />
        <Bar className='h-3 w-2/3' />
        <div className='flex items-center gap-2.5 pt-3'>
          <Bar className='size-6 rounded-full' />
          <Bar className='h-3 w-20' />
          <Bar className='ml-auto h-3 w-24' />
        </div>
      </div>
    </div>
  );
}

/* ── v2「编辑感横卡」 ───────────────────────────────────────────────────── */

export function CardV2({ topic, now, coverClass = 'aspect-square w-[6.5rem]' }: { topic: Topic; now: number; coverClass?: string }) {
  return (
    <article className='group flex gap-4 overflow-hidden rounded-md border border-border bg-card p-3 transition-colors hover:border-primary/50 sm:gap-5 sm:p-4'>
      {topic.cover ? (
        <TopicCover className={coverClass + ' shrink-0 rounded-sm'} kind='grid' title={topic.title} topicId={topic.id} />
      ) : (
        <NoCover className={coverClass + ' shrink-0 rounded-sm'} />
      )}

      <div className='flex min-w-0 flex-1 flex-col'>
        <div className='flex items-center gap-2 text-[11.5px] text-muted-foreground'>
          {topic.featured ? (
            <span className='inline-flex items-center gap-0.5 font-medium text-primary'>
              <Star aria-hidden className='size-3' />
              精华
            </span>
          ) : null}
          {topic.pinned ? <span className='font-medium text-foreground'>置顶</span> : null}
          <Kind kind={topic.kind} />
          <span className='ml-auto tabular-nums'>{relative(topic.last_reply_at, now)}</span>
        </div>

        <h3 className='mt-1.5 text-[15.5px] leading-[1.4] font-semibold text-foreground'>
          <a className='outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50' href={'#/t/' + topic.id}>
            {topic.title}
          </a>
        </h3>

        <p className='mt-1.5 line-clamp-2 text-[13px] leading-[1.65] text-muted-foreground'>{topic.excerpt}</p>

        <div className='mt-auto flex items-center gap-2 pt-3 text-[12px] text-muted-foreground'>
          <User nickname={topic.author.nickname} size={20} />
          <span className='truncate text-foreground'>{topic.author.nickname}</span>
          <span className='flex shrink-0 items-center gap-1 tabular-nums'>
            <MessageSquare aria-hidden className='size-3.5' />
            {topic.reply_count}
          </span>
          <Metrics className='ml-auto shrink-0' topic={topic} />
        </div>
      </div>
    </article>
  );
}

export function CardV2Skeleton({ coverClass = 'aspect-square w-[6.5rem]' }: { coverClass?: string }) {
  return (
    <div aria-hidden className='flex gap-4 rounded-md border border-border bg-card p-3 sm:gap-5 sm:p-4'>
      <Bar className={coverClass + ' shrink-0'} />
      <div className='flex flex-1 flex-col gap-2.5'>
        <Bar className='h-3 w-24' />
        <Bar className='h-4 w-10/12' />
        <Bar className='h-3 w-3/4' />
        <Bar className='mt-auto h-3 w-2/5' />
      </div>
    </div>
  );
}
