import type { ReactNode } from 'react';
import { BadgeCheck, CalendarDays, Heart, Star, UserRound } from 'lucide-react';
import { appPath } from '@/lib/url';
import { UserBadge } from '@/ui/user/user-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import type { TopicAuthor } from './types';

// 右栏第二格：发帖者卡片。**大头像 + 昵称 + 头衔 + 等级/经验 + 三个统计**。
// 身份部分全部复用 src/ui/user/*（头像用 UserAvatar，徽标用 RoleBadge/TitleBadge，
// 由 UserBadge stacked 一次拼好），等级条是唯一自绘的部分——Ring 的 ProgressBar 在这里
// 拿不到我们要的细高度与圆角，所以用令牌画的 div，没有新控件。
export function AuthorCard({ author }: { author: TopicAuthor }) {
  const pct = Math.round((author.exp / author.exp_max) * 100);
  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
      <div className='flex justify-center border-b border-border pb-3'>
        <UserBadge
          user={{ handle: author.handle, nickname: author.nickname, avatar: author.avatar, role: author.role, title: author.title }}
          layout='stacked'
          size='xl'
          showHandle
          badges='after'
        />
      </div>

      <div className='flex flex-col gap-2'>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{author.bio}</p>
        <span className='flex flex-wrap items-center gap-2'>
          <TitleBadge title={author.title ?? { name: '无头衔' }} size='sm' />
          <span className='inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
            <BadgeCheck aria-hidden className='size-3' />
            邮箱已验证
          </span>
        </span>
      </div>

      <div className='flex flex-col gap-1'>
        <span className='flex items-baseline justify-between text-[12px]'>
          <span className='text-foreground'>
            Lv.{author.level} <span className='text-muted-foreground'>· 战役作者</span>
          </span>
          <span className='tabular-nums text-muted-foreground'>
            {author.exp} / {author.exp_max} 经验
          </span>
        </span>
        <div
          role='progressbar'
          aria-valuemin={0}
          aria-valuemax={author.exp_max}
          aria-valuenow={author.exp}
          aria-label={'Lv.' + author.level + ' 经验进度'}
          className='h-1.5 w-full overflow-hidden rounded-full bg-muted'
        >
          <div className='h-full rounded-full bg-primary' style={{ width: pct + '%' }} />
        </div>
      </div>

      {/* 两格只放纯数字：248px 栏宽下三格只有 ~72px，日期必折行、栅格底线对不齐 */}
      <dl className='grid grid-cols-2 gap-1 border-t border-border pt-3 text-center'>
        <Cell icon={<Star aria-hidden className='size-3' />} label='帖子' value={author.topic_count} />
        <Cell icon={<Heart aria-hidden className='size-3' />} label='获赞' value={author.like_received} />
      </dl>

      {/* 加入时间 + 主页入口合成一行：日期不是数字，硬塞进栅格就会折行 */}
      <p className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground'>
        <span className='inline-flex items-center gap-1'>
          <CalendarDays aria-hidden className='size-3.5' />
          {author.joined_at}加入
        </span>
        <a
          href={appPath('u/' + author.handle)}
          className='ml-auto inline-flex items-center gap-1 rounded-[3px] outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
        >
          <UserRound aria-hidden className='size-3.5' />
          查看主页
        </a>
      </p>
    </section>
  );
}

function Cell({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className='flex flex-col items-center gap-0.5'>
      <dt className='order-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
        {icon}
        {label}
      </dt>
      <dd className='order-1 text-[14px] font-semibold tabular-nums text-foreground'>{value}</dd>
    </div>
  );
}