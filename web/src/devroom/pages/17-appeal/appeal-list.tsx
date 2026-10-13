import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import { FileClock, Inbox } from 'lucide-react';
import { Pill } from '@/devroom/pages/15-admin/bits';
import { roomHref, ProtoLink } from '@/devroom/room-links';
import { STATUS_LABEL, APPEAL_TYPE_LABEL, type AppealRecord, type AppealStatus } from './data';

// 「我的申诉」列表：本页提交过的记录 + 状态。
// 两个必须说清楚的点（不说清就是「看起来像坏了」）：
//   ① 未登录时这里**只显示本页提交过的**（我们没法证明你是谁，不能把全站记录摊开）；
//   ② 状态用已有的 Pill（15-admin/bits）—— 不新造徽标；「已答复」的内容直接摊在行里，
//      而不是让人再点一次（答复内容就是用户来这里的目的）。
export type AppealListProps = {
  records: AppealRecord[];
  /** 未登录：表头要写明「只显示你刚提交的」，否则会被当成「我的记录丢了」 */
  guest: boolean;
  /** 表头的「共 N 条」用 */
  total?: number;
};

const TONE: Record<AppealStatus, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  pending: 'warn',
  replied: 'ok',
  rejected: 'danger',
  closed: 'neutral',
};

export function StatusPill({ status }: { status: AppealStatus }) {
  return <Pill tone={TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

export function AppealList({ records, guest, total }: AppealListProps) {
  return (
    <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4'>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h2 className='flex items-center gap-1.5 text-[15px] font-semibold text-foreground'>
          <FileClock size={16} aria-hidden className='text-muted-foreground' />
          我的申诉
        </h2>
        <span className='text-[12px] text-muted-foreground'>共 {(total ?? records.length)} 条</span>
      </div>
      <p className='text-[12px] leading-relaxed text-muted-foreground'>
        {guest
          ? '你还没登录：除了刚刚在本页提交的那条，下面几条是示例记录（不是你的，只用来演示各状态长什么样）；示例刷新即消失。登录后这里才是这个账号的全部申诉。'
          : '这个账号提交过的申诉与反馈，按时间倒序。答复内容直接摊在行里，不用再点进去。'}
      </p>

      {records.length === 0 ? (
        <div className='flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-[12px] text-muted-foreground'>
          <Inbox size={16} aria-hidden />
          还没有提交过申诉或反馈。左边填一张表，提交后会立刻出现在这里（并给单号）。
        </div>
      ) : (
        <ul className='flex flex-col'>
          {records.map((r) => (
            <li key={r.no} className='flex flex-col gap-1.5 border-b border-border py-2.5 first:pt-0 last:border-0 last:pb-0'>
              <div className='flex flex-wrap items-center gap-2'>
                <Tag tagType={TagType.DEFAULT} className='text-[11px]'>
                  {APPEAL_TYPE_LABEL[r.type]}
                </Tag>
                <StatusPill status={r.status} />
                {/* 未登录时这几条不是本人提交的：标出来，免得被当成「我的记录里有一条不是我的」 */}
                {guest ? <Tag tagType={TagType.DEFAULT} className='text-[11px]'>示例</Tag> : null}
                <span className='ml-auto font-mono text-[11px] text-muted-foreground'>{r.no}</span>
              </div>
              <span className='text-[13px] font-medium text-foreground'>{r.title}</span>
              <span className='text-[11px] text-muted-foreground'>
                提交于 {r.submittedAt}
                {r.eta ? ' · 预计 ' + r.eta + ' 答复' : ''}
                {r.repliedAt ? ' · 答复于 ' + r.repliedAt : ''}
              </span>
              {r.reply ? (
                <span className='rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[12px] leading-relaxed text-foreground'>
                  {r.reply}
                </span>
              ) : (
                <span className='text-[11px] text-muted-foreground'>还在队列里：没有答复之前，这一行不会被删掉。</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className='text-[11px] leading-relaxed text-muted-foreground'>
        {guest ? '想看到全部记录，先' : '要看这个账号的资料，去'}
        {guest ? (
          <a className='ml-1 underline' href={roomHref('16-auth')}>
            登录
          </a>
        ) : (
          <a className='ml-1 underline' href={roomHref('11-profile')}>
            个人主页
          </a>
        )}
        ；登录页「账号已被封禁」那一态里也放了同一个入口。
        <ProtoLink what='站内公告《申诉与举报处理规则》' className='ml-1'>
          处理规则
        </ProtoLink>
        。
      </p>
    </section>
  );
}
