import Button from '@jetbrains/ring-ui-built/components/button/button';
import Tag, { TagType } from '@jetbrains/ring-ui-built/components/tag/tag';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { CalendarClock, MessageSquare } from 'lucide-react';
import { CommentBody } from '@/ui/comment/comment-body';
import { CommentList } from '@/ui/comment/comment-list';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import type { CommentData } from '@/ui/comment/types';
import { RoleBadge } from '@/ui/user/role-badge';
import { UserAvatar } from '@/ui/user/avatar';
import { UserBadge } from '@/ui/user/user-badge';
import { Username } from '@/ui/user/username';
import { ISSUE_KIND_META, ISSUE_STATUS_LABEL } from '../12-topic/_task/types';
import type { IssueDetail } from './types';

// 主从布局的右半：反馈正文 + 状态开关 + 评论区。
// 评论区**整体复用 @/ui/comment**（CommentList 里就是 ReplyBox + CommentItem + CommentReplies），
// 不自己写第二套评论。
export function IssueDetail({
  issue,
  comments,
  me,
  candidates,
  onSetStatus,
  onComment,
  onVote,
  onClose,
}: {
  issue: IssueDetail;
  comments: CommentData[];
  me: { nickname: string; avatar?: string | null };
  candidates: MentionCandidate[];
  onSetStatus: (next: IssueDetail['status']) => void;
  onComment: (parentId: string | null, body: { json: string; html: string }) => void;
  /** 评论的赞 / 踩：不传就是只显示两个数字（后端 PUT /issue-comments/{id}/vote 一直在） */
  onVote?: (id: string, value: 1 | -1) => void;
  onClose: () => void;
}) {
  const open = issue.status === 'open';
  return (
    <section className='flex flex-col gap-5' aria-label={'反馈 #' + issue.id}>
      <header className='flex flex-col gap-3 border-b border-border pb-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='rounded-[3px] bg-muted px-2 py-0.5 text-[12px] font-medium tabular-nums text-muted-foreground'>
            {ISSUE_STATUS_LABEL[issue.status]}
          </span>
          <h2 className='min-w-0 flex-1 text-xl leading-snug font-semibold text-foreground'>{issue.title}</h2>
          <Button ghost onClick={onClose}>
            收起详情
          </Button>
        </div>

        <div className='flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-muted-foreground'>
          <span className='rounded-[3px] bg-muted px-1.5 py-0.5 tabular-nums'>#{issue.id}</span>
          <Tag tagType={TagType.DEFAULT} className='text-[11px]'>
            {ISSUE_KIND_META[issue.kind].label}
          </Tag>
          {issue.labels.map((l) => (
            <Tag key={l} tagType={TagType.MAIN} className='text-[11px]'>
              {l}
            </Tag>
          ))}
          <span className='inline-flex items-center gap-1 tabular-nums'>
            <MessageSquare aria-hidden className='size-3.5' /> {issue.commentCount} 条评论
          </span>
          <span className='inline-flex items-center gap-1 tabular-nums'>
            <CalendarClock aria-hidden className='size-3.5' /> 更新于 {issue.updatedAt}
          </span>
        </div>

        <div className='flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-border bg-card p-3'>
          <span className='flex items-center gap-2'>
            <UserAvatar name={issue.author.nickname} src={issue.author.avatar} size='md' />
            <span className='flex flex-col'>
              <Username nickname={issue.author.nickname} size='md' strong />
              {issue.author.role ? <RoleBadge role={issue.author.role} /> : null}
            </span>
          </span>
          <span className='flex items-center gap-2 text-[12px] text-muted-foreground'>
            指派给
            {issue.assignee ? (
              <UserBadge user={issue.assignee} size='sm' />
            ) : (
              <span className='rounded-[3px] bg-muted px-1.5 py-0.5'>暂未指派</span>
            )}
          </span>
          <span className='ml-auto'>
            <Toggle checked={open} onChange={(e) => onSetStatus(e.target.checked ? 'open' : 'closed')} help={'当前：' + ISSUE_STATUS_LABEL[issue.status] + '（关掉即 Closed）'}>
              {open ? '待处理 Open' : '已关闭 Closed'}
            </Toggle>
          </span>
        </div>
      </header>

      <article className='rounded-lg border border-border bg-card p-4'>
        <CommentBody body={issue.bodyHtml} className='prose-sm max-w-none text-[15px] leading-[1.75] text-foreground' />
      </article>

      <CommentList
        comments={comments}
        total={issue.commentCount}
        me={me}
        candidates={candidates}
        onSubmit={onComment}
        onVote={onVote}
      />
    </section>
  );
}
