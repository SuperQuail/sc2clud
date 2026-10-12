import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import Tooltip from '@jetbrains/ring-ui-built/components/tooltip/tooltip';
import { CircleCheckBig, CircleDot, type LucideIcon } from 'lucide-react';
import { UserBadge } from '@/ui/user/user-badge';
import { cn } from '@/lib/utils';
import { ISSUE_KIND_META, ISSUE_STATUS_LABEL, type IssueKind, type IssueStatus, type IssueSummary } from './types';

// Issue 列表的一行（照 GitHub Issue 列表项）：**纯展示**——不写链接、不写点击，
// 点击行为由列表容器决定（外面套 <a> 或挂 onClick），所以分区页、Issue 页、搜索页共用同一行。
// 无障碍：状态只有图形能表达，所以补 role="img" + aria-label（悬停另有 Tooltip）；
// 颜色不是唯一的信息载体——标签文字同时给出类型，Tooltip/aria 给出状态。
const STATUS: Record<IssueStatus, { icon: LucideIcon; className: string }> = {
  open: { icon: CircleDot, className: 'text-[var(--ring-icon-success-color)]' },
  closed: { icon: CircleCheckBig, className: 'text-[var(--ring-purple-text-color)]' },
};

/** 标签色与 ISSUE_KIND_ACCENT 是同一套语义（红/蓝/橙/紫），这里用 Ring UI Tag 的预设色实现 */
const KIND_TAG: Record<IssueKind, TagType> = {
  bug: TagType.ERROR,
  feature: TagType.MAIN,
  difficulty: TagType.WARNING,
  other: TagType.PURPLE,
};

/** 一个 Issue 的展示所需：id / kind / title / status / author / commentCount / createdAt / updatedAt（见 types.ts） */
export type IssueCardProps = {
  issue: IssueSummary;
};

export function IssueCard({ issue }: IssueCardProps) {
  const status = STATUS[issue.status];
  const StatusIcon = status.icon;
  const statusLabel = ISSUE_STATUS_LABEL[issue.status];
  return (
    <article className='flex items-start gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40'>
      <Tooltip title={'状态：' + statusLabel}>
        <span
          role='img'
          aria-label={'状态：' + statusLabel}
          className={cn('mt-0.5 grid size-5 shrink-0 place-items-center', status.className)}
        >
          <StatusIcon size={16} aria-hidden />
        </span>
      </Tooltip>
      <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
          <span className='min-w-0 text-[15px] font-medium text-foreground'>{issue.title}</span>
          <Tag tagType={KIND_TAG[issue.kind]}>{ISSUE_KIND_META[issue.kind].label}</Tag>
        </div>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground'>
          <span className='font-medium tabular-nums'>#{issue.id}</span>
          <UserBadge user={issue.author} size='sm' />
          <span className='tabular-nums'>· {issue.commentCount} 条评论</span>
          <span className='tabular-nums'>· 更新于 {issue.updatedAt}</span>
        </div>
      </div>
    </article>
  );
}
