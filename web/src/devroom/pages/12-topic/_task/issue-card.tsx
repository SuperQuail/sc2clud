import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import Tooltip from '@jetbrains/ring-ui-built/components/tooltip/tooltip';
import { CircleCheckBig, CircleDot, type LucideIcon } from 'lucide-react';
import { UserBadge } from '@/ui/user/user-badge';
import { cn } from '@/lib/utils';
import { ISSUE_STATUS_LABEL, type IssueKind, type IssueStatus, type IssueSummary, resolveKindName } from './types';

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
/** kind → 标签的显示名。**默认走前端那份已知话术**，而值域来自端点的页面会把端点的 name 传进来
 *  （宿主已经拿得到它，就不必为了「列表上那一格中文名」再多发一次请求）。 */
export type KindNames = Record<string, string>;

export type IssueCardProps = {
  issue: IssueSummary;
  /** kind → 中文名（选项来自 `GET /issues/kinds` 时由宿主给）。缺这个 kind 就回落前端话术。 */
  kindNames?: KindNames;
};

export function IssueCard({ issue, kindNames }: IssueCardProps) {
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
          {/* 未登记的 kind 回落成「其他」的标签色（值域是数据驱动的，外观是前端的设计决定） */}
          <Tag tagType={KIND_TAG[issue.kind] ?? KIND_TAG.other!}>{resolveKindName(issue.kind, kindNames?.[issue.kind])}</Tag>
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
