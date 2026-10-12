// 方向 D / 紧凑视图 B2（参考 Discord 消息列表，不抄视觉）：
//   头像在左；名字 / 徽标 / 时间同一行；标题与摘要紧随其后。
//   关键约束：行与行之间**没有边框分割** —— 靠行距与 hover 底色区分；
//   置顶 / 精华只用左侧细条 + 小标记，不用大色块；元信息是弱化的小字，不堆成表格。
import { Image as ImageIcon, Pin, Star } from 'lucide-react';
import { Bar, Kind, User } from './bits';
import { relative, type Topic } from './data';
import { TopicCover } from './art';

/** 行首细条：置顶走主色，精华走弱色；都没有就占位保持左边距一致。 */
function Stripe({ topic }: { topic: Topic }) {
  const cls = topic.pinned ? 'bg-primary' : topic.featured ? 'bg-primary/40' : 'bg-transparent';
  return <span aria-hidden className={['w-[3px] shrink-0 self-stretch rounded-full', cls].join(' ')} />;
}

/* ── v1：节奏紧（单行标题 + 摘要），hover 整行浅底 ───────────────────────── */

export function RowV1({ topic, now }: { topic: Topic; now: number }) {
  return (
    <article className='flex items-stretch gap-3 rounded-sm px-2 py-1.5 transition-colors hover:bg-accent/70'>
      <Stripe topic={topic} />
      <span className='pt-0.5'>
        <User nickname={topic.author.nickname} size={28} />
      </span>

      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-5'>
          <span className='font-semibold text-foreground'>{topic.author.nickname}</span>
          <span className='text-[11px] text-muted-foreground tabular-nums'>{relative(topic.last_reply_at, now)}</span>
          <Kind kind={topic.kind} />
          {topic.pinned ? (
            <span className='inline-flex items-center gap-0.5 text-[11px] font-medium text-primary'>
              <Pin aria-hidden className='size-3' />
              置顶
            </span>
          ) : null}
          {topic.featured ? (
            <span className='inline-flex items-center gap-0.5 text-[11px] font-medium text-primary'>
              <Star aria-hidden className='size-3' />
              精华
            </span>
          ) : null}
          <span className='ml-auto flex shrink-0 items-center gap-2.5 pl-3 text-[11.5px] text-muted-foreground tabular-nums'>
            <span title='回复数'>{topic.reply_count} 回复</span>
            <span title='点赞数'>{topic.like_count} 赞</span>
            <span title='浏览数' className='hidden sm:inline'>{topic.view_count} 阅</span>
          </span>
        </div>

        <h3 className='mt-0.5 text-[14.5px] leading-[1.45] font-medium text-foreground'>
          <a className='outline-none hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50' href={'#/t/' + topic.id}>
            {topic.title}
          </a>
        </h3>
        <p className='line-clamp-1 text-[12.5px] leading-5 text-muted-foreground'>{topic.excerpt}</p>
      </div>

      {topic.cover ? (
        <TopicCover className='mt-0.5 hidden aspect-[4/3] w-14 shrink-0 rounded-sm lg:block' kind='mesh' title={topic.title} topicId={topic.id} />
      ) : (
        <span aria-hidden className='mt-1 hidden w-14 shrink-0 items-center justify-center text-muted-foreground/35 lg:flex'>
          <ImageIcon className='size-4' />
        </span>
      )}
    </article>
  );
}

export function RowV1Skeleton() {
  return (
    <div aria-hidden className='flex items-center gap-3 px-2 py-1.5'>
      <span className='w-[3px] self-stretch' />
      <Bar className='size-7 shrink-0 rounded-full' />
      <div className='flex-1 space-y-1.5'>
        <Bar className='h-2.5 w-40' />
        <Bar className='h-3.5 w-9/12' />
        <Bar className='h-2.5 w-1/2' />
      </div>
    </div>
  );
}

/* ── v2：更矮（作者 / 时间 / 标题同一行），信息靠右对齐成一列 ───────────── */

export function RowV2({ topic, now }: { topic: Topic; now: number }) {
  return (
    <article className='flex items-center gap-3 rounded-sm px-2 py-1 transition-colors hover:bg-accent/70'>
      <Stripe topic={topic} />
      <User nickname={topic.author.nickname} size={24} />

      <div className='flex min-w-0 flex-1 items-baseline gap-2'>
        <span className='shrink-0 text-[12.5px] font-semibold text-foreground'>{topic.author.nickname}</span>
        <span className='hidden shrink-0 text-[11px] text-muted-foreground tabular-nums sm:inline'>
          {relative(topic.last_reply_at, now)}
        </span>
        <span aria-hidden className='hidden shrink-0 text-muted-foreground/40 sm:inline'>·</span>
        <span className='min-w-0 truncate text-[14px] font-medium text-foreground'>
          <a className='outline-none hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50' href={'#/t/' + topic.id}>
            {topic.title}
          </a>
        </span>
        <Kind kind={topic.kind} />
        {topic.pinned ? <Pin aria-hidden className='size-3 shrink-0 text-primary' /> : null}
        {topic.featured ? <Star aria-hidden className='size-3 shrink-0 text-primary/70' /> : null}
      </div>

      <span className='hidden shrink-0 items-center gap-3 text-[11.5px] text-muted-foreground tabular-nums md:flex'>
        <span title='回复数'>{topic.reply_count}</span>
        <span title='点赞数'>{topic.like_count}</span>
        <span title='浏览数' className='hidden lg:inline'>{topic.view_count}</span>
      </span>
    </article>
  );
}

export function RowV2Skeleton() {
  return (
    <div aria-hidden className='flex items-center gap-3 px-2 py-1'>
      <span className='w-[3px] self-stretch' />
      <Bar className='size-6 shrink-0 rounded-full' />
      <Bar className='h-3 w-20' />
      <Bar className='h-3.5 flex-1' />
      <Bar className='hidden h-2.5 w-24 md:block' />
    </div>
  );
}
