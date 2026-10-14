import type { ReactNode } from 'react';
import { BadgeCheck, CalendarDays, Heart, Star, UserRound } from 'lucide-react';
import { UserBadge } from '@/ui/user/user-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import type { TopicAuthor } from './types';

// 右栏第二格：发帖者卡片。**大头像 + 昵称 + 头衔 + 等级/经验 + 三个统计**。
// 身份部分全部复用 src/ui/user/*（头像用 UserAvatar，徽标用 RoleBadge/TitleBadge，
// 由 UserBadge stacked 一次拼好），等级条是唯一自绘的部分——Ring 的 ProgressBar 在这里
// 拿不到我们要的细高度与圆角，所以用令牌画的 div，没有新控件。
// 主页链接由宿主给（房间指 11-profile，真站指 /u/<handle>）：组件不认识路由。
export function AuthorCard({ author, profileHref }: { author: TopicAuthor; profileHref: string }) {
  const pct = Math.round((author.exp / author.exp_max) * 100);
  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
      <div className='flex justify-center border-b border-border pb-3'>
        {/* D8：头像与昵称都能点进主页（原来整个右栏只有底下一行「查看主页」，
            读者看着头像点不动）。链接由宿主给（房间指 11-profile，真站指 /u/<handle>）。 */}
        <a
          href={profileHref}
          title={'查看 ' + author.nickname + ' 的主页'}
          className='inline-flex rounded-[3px] outline-none hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50'
        >
          {/* badges='below' 而不是 'after'：假名单里的昵称变长了（「示范管理员」「虚空辉光舰」），
              inline 排法下昵称的可读宽度被角色/头衔徽标挤掉、会截成「示…」；
              徽标换到名字下一行后昵称独占整行（截图发现的，不是猜的）。 */}
          <UserBadge
            user={{ handle: author.handle, nickname: author.nickname, avatar: author.avatar, role: author.role, title: author.title }}
            layout='stacked'
            size='xl'
            showHandle
            badges='below'
          />
        </a>
      </div>

      <div className='flex flex-col gap-2'>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{author.bio}</p>
        {/* D17：这一行与头像/昵称/角色**同一条中轴**（原先左对齐，同一列里两种对齐）。
            D16：没有头衔就**不画那一枚** —— 与另外四处（comment-item / topic-row / user-badge / profile-hero）
            同一口径；原先写的是 `author.title ?? { name: '无头衔' }`，等于替人编了一个他没有的头衔。 */}
        <span data-testid='author-title-row' className='flex flex-wrap items-center justify-center gap-2'>
          {author.title ? <TitleBadge title={author.title} size='sm' /> : null}
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
          href={profileHref}
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