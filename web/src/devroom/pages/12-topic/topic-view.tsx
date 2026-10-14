import { Suspense, lazy, useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import type { CommentData } from '@/ui/comment/types';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import type { ReportReason } from '@/lib/api/forum';
import { TopicTaskTabs, type TopicTaskTab } from './_task/task-tabs';
import type { IssueKind } from './_task/types';
import { AuthorCard } from './author-card';
import { BoardSummary } from './board-summary';
import { IssueNudge } from './issue-nudge';
import { LeftRail } from './left-rail';
import { MainColumn, TopicMeta } from './main-column';
import { AuthorOnlyHint, ReviewAppealButton, ReviewResubmitButton, type ReviewState } from './review-state';
import { RewardPanel } from './reward-panel';
import type { Board, BoardNav, BoardSlug, PaymentChannel, TopicAuthor, TopicDetail } from './types';

// 两个弹层**按需加载**（与「评论区」同一个理由）：它们只在点「举报 / 编辑」时才需要，
// 却会把 Ring 的 Dialog + Radio + Input 整包拖进公开首屏 —— 实测这一页给首屏加了约 50KB gzip，
// 而首屏预算一共 150KB（前端方案 §9.1）。首屏 JS 只花在首屏真要用的东西上。
const ReportDialog = lazy(() => import('./report-dialog').then((m) => ({ default: m.ReportDialog })));
const EditTopicDialog = lazy(() => import('./edit-dialog').then((m) => ({ default: m.EditTopicDialog })));

// 12-topic 的**整页组合**：顶部两个大页签 → 三栏（左：分区与分区内导航／中：全文+来源+动作+评论／
// 右：分区简介→发帖者→赞助→问题反馈）。
//
// 这一版是**prop 驱动**的：房间（./index.tsx）与真站（src/routes/topic.tsx）都渲染这一个组件。
// 为什么必须这样：「设计稿里验收过的那一屏」与「用户看到的那一屏」只能是同一份代码 ——
// 两份实现必然在按钮位置、字距、加载态上分叉，而分叉出来的那一份没有人在房间里看过。
//
// 边界（照前端方案 §4.1 的依赖方向）：
//   · 组件只摆版式、只管**界面状态**（开哪个页签/弹层、删除确认）；
//   · 数据（帖子、评论、审核态、赞助渠道）与**动作**（点赞、举报、编辑、回复）全部由宿主给：
//     房间给本地演示，真站给 lib/api。
//   · 路径也由宿主给（boardHref / authorHref / composeHref…）：房间指房间里的页，真站指真路径。

/** 审核态：后端 review_state / review_note / review_pending_human 三件（pending 的两档文案） */
export type TopicReview = {
  state: ReviewState;
  /** 后端还没有这个字段（shortcut）：真站先恒 false，等于「正在自动检查」那一档 */
  pendingHuman?: boolean;
  /** topics.review_note：AI 给的中文理由，**只有 rejected 才有值** */
  note?: string | null;
};

export type TopicViewProps = {
  // —— 分区（左栏 + 右栏第一格）——
  boards: Board[];
  board: Board;
  boardNav: BoardNav[];
  boardHref: (slug: BoardSlug) => string;
  navValue: string;
  onNavChange: (key: string) => void;
  composeHref: string;
  onJoin?: () => void;
  authorHref: string;
  author: TopicAuthor;

  // —— 帖子 ——
  topic: TopicDetail;
  review: TopicReview;
  canEdit: boolean;
  liked: boolean;
  bookmarked: boolean;
  likeCount: number;
  /** 收藏数：后端没有这个字段，拿不到就不显示（见 TopicActions 的注释） */
  bookmarkCount?: number;
  onToggleLike?: () => void;
  onToggleBookmark?: () => void;
  onCopyLink?: () => void;
  onEdit?: (next: { title: string; text: string }) => void;
  /** target = 被举报的回复；null = 帖子本身（真站要按它填 target_type / target_id） */
  onSubmitReport?: (reason: ReportReason, detail: string, target: { id: string; label: string } | null) => void;
  /** 本人已经举报过这篇帖子（后端是幂等的：重复举报回 200 + 既有那条） */
  reported: boolean;
  reportedIds: string[];
  onDelete?: () => void;
  deleting?: boolean;
  /** 未通过审核时的两个出口：宿主不给就不渲染那颗按钮（后端还没有端点时，给了也只是回执） */
  onAppeal?: () => void;
  onResubmit?: () => void;

  // —— 评论 ——
  comments: CommentData[];
  commentTotal: number;
  candidates: MentionCandidate[];
  me: { handle: string; nickname: string; avatar?: string | null };
  newSeqs?: Record<string, number>;
  onSubmitComment: (parentId: string | null, body: { json: string; html: string }) => void;
  onDeleteComment: (parentId: string | null, id: string) => void;
  onVoteComment: (id: string, value: 1 | -1) => void;
  replyPrompt?: ReactNode;
  /** 评论区还没到 / 拿不到时替换整个评论区的那一块（宿主用 Loading / ErrorState 造） */
  commentsFallback?: ReactNode;

  // —— 右栏后两格 ——
  channels: PaymentChannel[];
  issueCount: number;
  /** 反馈页的地址；还没有那一页时改给 onOpenFeedback（点一下有回执，不留 404 死链） */
  feedbackHref?: string;
  onOpenFeedback?: (kind?: IssueKind) => void;
  onOpenIssue: () => void;

  // —— 下载来源能不能点（房间没有转链端点）——
  sourcesLinked?: boolean;
  /** 动作回执：由宿主持有（房间是本地状态，真站是请求结果） */
  receipt?: ReactNode;
  /** 初值：只给出图脚本用（房间 ?open=report|edit 直接拍到交互态），真站不传 */
  initialLayer?: 'report' | 'edit' | 'delete' | null;
};

export function TopicView({
  boards,
  board,
  boardNav,
  boardHref,
  navValue,
  onNavChange,
  composeHref,
  onJoin,
  authorHref,
  author,
  topic,
  review,
  canEdit,
  liked,
  bookmarked,
  likeCount,
  bookmarkCount,
  onToggleLike,
  onToggleBookmark,
  onCopyLink,
  onEdit,
  onSubmitReport,
  reported,
  reportedIds,
  onDelete,
  deleting = false,
  onAppeal,
  onResubmit,
  comments,
  commentTotal,
  candidates,
  me,
  newSeqs,
  onSubmitComment,
  onDeleteComment,
  onVoteComment,
  replyPrompt,
  commentsFallback,
  channels,
  issueCount,
  feedbackHref,
  onOpenFeedback,
  onOpenIssue,
  sourcesLinked = false,
  receipt,
  initialLayer = null,
}: TopicViewProps) {
  const [tab, setTab] = useState<TopicTaskTab>('content');
  // 弹层与确认：只开一个（举报 / 编辑 / 删帖三件事各是各的，同时开着人不知道自己在确认什么）
  const [layer, setLayer] = useState<'report' | 'edit' | 'delete' | null>(initialLayer);
  // 举报对象：null = 帖子本身，非 null = 某条回复（回复级举报带 target_type=post）
  const [reportTarget, setReportTarget] = useState<{ id: string; label: string } | null>(null);

  const rejected = review.state === 'rejected';

  function openReport(target: { id: string; label: string } | null) {
    setReportTarget(target);
    setLayer('report');
  }

  return (
    <div className='flex w-full flex-col gap-4'>
      <TopicTaskTabs value={tab} onChange={setTab} issueCount={issueCount} onOpenIssue={onOpenIssue} />

      <div className='grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-[minmax(0,1fr)_248px] xl:flex xl:items-start'>
        {/* 左栏：只在 ≥1200px 出现。用 hidden 而不是挪到底部——它是「常驻栏」，不该在窄屏抢首屏 */}
        <aside aria-label='分区与分区内导航' className='hidden xl:block xl:w-[200px] xl:shrink-0'>
          <LeftRail
            boards={boards}
            currentSlug={board.slug}
            nav={boardNav}
            navValue={navValue}
            onNavChange={onNavChange}
            boardHref={boardHref}
          />
        </aside>

        {/* 中栏：主区。窄屏靠 row-start 抢回第一格，右栏因此落在它下面、评论之前 */}
        <main data-testid='topic-main' className='flex min-w-0 flex-col gap-3 md:col-start-1 md:row-start-1 xl:flex-1'>
          <TopicMeta topic={topic} boardHref={boardHref(board.slug)} />
          <MainColumn
            topic={topic}
            comments={comments}
            commentTotal={commentTotal}
            candidates={candidates}
            me={me}
            issues={
              <IssueNudge issueCount={issueCount} href={feedbackHref} onOpen={feedbackHref ? undefined : onOpenFeedback} />
            }
            reviewState={review.state}
            reviewPendingHuman={review.pendingHuman ?? false}
            reviewNote={review.note ?? null}
            reviewAppeal={rejected && onAppeal ? <ReviewAppealButton onAppeal={onAppeal} /> : null}
            reviewResubmit={rejected && onResubmit ? <ReviewResubmitButton onResubmit={onResubmit} /> : null}
            reported={reported}
            canEdit={canEdit}
            liked={liked}
            bookmarked={bookmarked}
            likeCount={likeCount}
            bookmarkCount={bookmarkCount}
            onToggleLike={onToggleLike}
            onToggleBookmark={onToggleBookmark}
            onCopyLink={onCopyLink}
            onReport={() => openReport(null)}
            onEdit={onEdit ? () => setLayer('edit') : undefined}
            onDelete={onDelete ? () => setLayer('delete') : undefined}
            deleteConfirm={
              layer === 'delete' ? (
                <section className='flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-3'>
                  <span className='text-[13px] font-medium text-foreground'>删除这篇帖子？</span>
                  <span className='text-[12px] text-muted-foreground'>
                    删除后帖子从列表里消失，正文会被标记为作者删除（平台侧仍留审计痕迹，不是物理删除）。
                  </span>
                  <span className='flex flex-wrap items-center gap-2'>
                    <Button
                      data-testid='topic-delete-confirm'
                      primary
                      inline={false}
                      height={ControlsHeight.S}
                      disabled={deleting}
                      onClick={() => {
                        setLayer(null);
                        onDelete?.();
                      }}
                    >
                      确认删除
                    </Button>
                    <Button inline={false} height={ControlsHeight.S} onClick={() => setLayer(null)}>
                      取消
                    </Button>
                  </span>
                </section>
              ) : null
            }
            onVote={onVoteComment}
            onDeleteComment={onDeleteComment}
            onSubmitComment={onSubmitComment}
            reportedIds={reportedIds}
            onReportComment={(t) => openReport(t)}
            newSeqs={newSeqs}
            replyPrompt={replyPrompt}
            commentsFallback={commentsFallback}
            sourcesLinked={sourcesLinked}
            receipt={receipt}
            reportDialog={
              layer === 'report' ? (
                <Suspense fallback={<p className='text-[13px] text-muted-foreground'>正在打开举报…</p>}>
                  <ReportDialog
                  // 帖子级：只说「你已举报过」不说上次的事由 —— 后端幂等（重复举报回 200 + 既有那条），
                  // 而详情响应里没有「我举报它时选的是哪一条」，编一个事由就是假信息。
                  targetLabel={
                    reportTarget ? reportTarget.label : '帖子 · ' + topic.title + (reported ? '（你已举报过）' : '')
                  }
                  onSubmit={(reason, detail) => {
                    setLayer(null);
                    onSubmitReport?.(reason, detail, reportTarget);
                  }}
                    onClose={() => setLayer(null)}
                  />
                </Suspense>
              ) : null
            }
            editDialog={
              layer === 'edit' ? (
                <Suspense fallback={<p className='text-[13px] text-muted-foreground'>正在打开编辑…</p>}>
                  <EditTopicDialog
                  title={topic.title}
                  text={toText(topic.content_html)}
                  onSave={(next) => {
                    setLayer(null);
                    onEdit?.(next);
                  }}
                    onClose={() => setLayer(null)}
                  />
                </Suspense>
              ) : null
            }
          />
          {/* 「只有作者能看到」的说明放在卡片外、动作条与评论区之后：
              它是这一屏的注解，不是正文的一部分；正文与评论区照常渲染（作者当然能看自己的）。
              approved 时不渲染——正常帖没有这句话可说。 */}
          {review.state === 'approved' ? null : <AuthorOnlyHint />}
        </main>

        {/* 右栏：分区简介 → 发帖者卡片 → 赞助 → 问题反馈入口。长帖里跟着滚 */}
        <aside
          data-testid='topic-rail'
          className='flex min-w-0 flex-col gap-4 md:col-start-2 md:row-span-2 md:row-start-1 xl:sticky xl:top-4 xl:w-[248px] xl:shrink-0'
        >
          <BoardSummary board={board} composeHref={composeHref} onJoin={onJoin} />
          <AuthorCard author={author} profileHref={authorHref} />
          <RewardPanel channels={channels} />
          <IssueNudge
            variant='rail'
            issueCount={issueCount}
            href={feedbackHref}
            onOpen={feedbackHref ? undefined : onOpenFeedback}
          />
        </aside>
      </div>
    </div>
  );
}

/** 编辑弹层的初值：从 content_html 剥标签得到纯文本（块级标签的收尾当段落分隔）。 */
export function toText(html: string): string {
  return html
    .replace(/<\/(p|h[1-6]|li|blockquote)>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
