import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { createReport, type ReportReason } from '@/lib/api/forum';
import { IssueCard } from '@/devroom/pages/12-topic/_task/issue-card';
import type { IssueSummary } from '@/devroom/pages/12-topic/_task/types';
import { IssueReportButton } from '@/devroom/pages/13-issue/report-entry';

// 问题反馈列表的**行 + 行上的举报入口**。从 routes/issues.tsx 搬出来（那个文件在 gate:size 的 500 行线上）：
// 这一块是「行容器 + 举报接线」，与宿主该留的「取数 + 传参」是两件事。
//
// 行的行为一个字没改（role=button / Enter+Space / aria-current / aria-label）；
// 举报对象是 issue 的 **public_id**（uuid），不是卡片上显示的 #编号 —— 所以它由这条行的 issueId 带进来。

export function IssueRow({
  issueId,
  number,
  issue,
  selected,
  onOpen,
  onReported,
  demo = false,
}: {
  /** issue 的 public_id（uuid）：举报上报的就是它 */
  issueId: string;
  /** 帖内编号（#N）：只用来给人看 */
  number: number;
  /** 设计件吃的行模型（IssueCard 只认它） */
  issue: IssueSummary;
  selected: boolean;
  onOpen: () => void;
  /** 举报提交成功后的回执交给宿主显示 */
  onReported: (label: string) => void;
  /** 房间（DevRoom 13）用：**不发真请求**，走同一套步骤给本地回执（照 15-admin 房间的先例）。 */
  demo?: boolean;
}) {
  const label = '反馈 #' + number + '「' + issue.title + '」';
  return (
    <div
      role='button'
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={'打开反馈 #' + issue.id + ' ' + issue.title}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'relative cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected && 'bg-muted/60',
      )}
    >
      <IssueCard issue={issue} />
      {/* 举报挂在行的右上角（绝对定位，不挤动卡片本身）；行本身仍然是同一个点击容器。 */}
      <span className='absolute top-2 right-2' onClick={(e) => e.stopPropagation()}>
        <IssueReportButton
          testId={'issue-report-' + issueId}
          targetLabel={label}
          // 契约：target_type='issue'、target_id=public_id（不是 #编号）
          onSubmit={(reason: ReportReason, detail: string) =>
            demo
              ? Promise.resolve()
              : createReport({ target_type: 'issue', target_id: issueId, reason, detail: detail || undefined })}
          onDone={onReported}
        />
      </span>
    </div>
  );
}

/** 详情面板里的举报入口（对象是**详情响应**那条：public_id 从详情拿，设计件的 id 是 #编号）。 */
export function issueDetailReport({
  issueId,
  number,
  title,
  onReported,
}: {
  issueId: string;
  number: number;
  title: string;
  onReported: (label: string) => void;
}): ReactNode {
  return (
    <IssueReportButton
      testId='issue-detail-report'
      targetLabel={'反馈 #' + number + '「' + title + '」'}
      onSubmit={(reason: ReportReason, detail: string) =>
        createReport({ target_type: 'issue', target_id: issueId, reason, detail: detail || undefined })}
      onDone={onReported}
    />
  );
}
