import { Suspense, lazy, useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import type { CommentData } from '@/ui/comment/types';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import type { ReportReason } from '@/lib/api/forum';
import { TopicTaskTabs, type TopicTaskTab } from './_task/task-tabs';
import type { IssueKind } from './_task/types';
import { AuthorCard, type AuthorFollow } from './author-card';
import { BoardSummary } from './board-summary';
import { IssueNudge } from './issue-nudge';
import { LeftRail } from './left-rail';
import { MainColumn, TopicMeta } from './main-column';
import { AuthorOnlyHint, ReviewAppealButton, ReviewResubmitButton, ReviewRevisionButton, type ReviewState } from './review-state';
import { RewardPanel } from './reward-panel';
// 类型名与右栏那一格的组件 BoardSummary（./board-summary）撞车，所以这里起别名（交接单 §5.6 的老坑）
import type { BoardSummary as RailBoard, RailLink } from '@/devroom/pages/03-navigation/board-rail';
import type { Board, BoardNav, BoardSlug, PaymentChannel, TopicAuthor, TopicDetail } from './types';
import { RevisionDialog } from './revision-dialog';

// 两个弹层**按需加载**（与「评论区」同一个理由）：它们只在点「举报 / 编辑」时才需要，
// 却会把 Ring 的 Dialog + Radio + Input 整包拖进公开首屏 —— 实测这一页给首屏加了约 50KB gzip，
// 而首屏预算一共 150KB（前端方案 §9.1）。首屏 JS 只花在首屏真要用的东西上。
const ReportDialog = lazy(() => import('./report-dialog').then((m) => ({ default: m.ReportDialog })));

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
  /**
   * L6：打回修改时后端给的**最后一个过审版本**（`TopicDetailDTO.revision_of`）。
   * 「打回期间只有作者可见可编辑」，所以这份内容是作者改坏之后的唯一参照 ——
   * 界面上要有入口能看到它，否则「原始版本已过审就显示它」这句话落不了地。
   */
  revision?: { content_html: string; approved_at: string } | null;
  /** 后端还没有这个字段（shortcut）：真站先恒 false，等于「正在自动检查」那一档 */
  pendingHuman?: boolean;
  /** L7：这一次 pending 是作者改完正文重提上来的（真站由「刚保存 + 服务端回了 pending」推出） */
  resubmitted?: boolean;
  /** topics.review_note：AI 给的中文理由，**只有 rejected 才有值** */
  note?: string | null;
};

export type TopicViewProps = {
  // —— 分区（左栏 + 右栏第一格）——
  /** 左栏的分区列表。**就是 03-navigation BoardRail 吃的那个形状**（后端 BoardDTO 的 cover_hash，
   *  裸哈希）—— 左栏不再自己画一份分区行，两处封面逻辑因此只剩一份（D21）。 */
  boards: RailBoard[];
  /** 左栏分区行的落地件（View 里不出现 react-router）：产品传 Link，房间传不可导航的 span */
  boardLink?: RailLink;
  board: Board;
  boardNav: BoardNav[];
  boardHref: (slug: BoardSlug) => string;
  navValue: string;
  onNavChange: (key: string) => void;
  composeHref: string;
  onJoin?: () => void;
  authorHref: string;
  author: TopicAuthor;
  /** 关注作者（D19）：三态由宿主给（自己看自己不传 / 未登录给 loginHref / 登录给 following+onToggle）。
   *  真站接的是 PUT/DELETE /users/{handle}/follow，房间接本地状态。 */
  authorFollow?: AuthorFollow;

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
  /** 编辑走**发帖页**（用户 2026-10-15：帖内小弹层撤掉，编辑复用 18-compose 的编辑态）。
   *  宿主注入跳转地址（产品 /new?edit=<public_id>；房间 ?page=18-compose&edit=<id>），
   *  保存在发帖页里发生（PATCH /topics/:id），帖页等刷新后的详情。canEdit=false 或
   *  宿主不给地址都不渲染按钮。 */
  editHref?: (topicId: string) => string;
  /** target = 被举报的回复；null = 帖子本身（真站要按它填 target_type / target_id） */
  onSubmitReport?: (reason: ReportReason, detail: string, target: { id: string; label: string } | null) => void;
  /** 本人已经举报过这篇帖子（后端是幂等的：重复举报回 200 + 既有那条） */
  reported: boolean;
  reportedIds: string[];
  onDelete?: () => void;
  deleting?: boolean;
  /** 版主的两颗开关（D73）：含义与渲染规则见 TopicActions；房间不传就整组不渲染 */
  pinOn?: boolean;
  featureOn?: boolean;
  pinPending?: boolean;
  onTogglePin?: (next: boolean) => void;
  onToggleFeature?: (next: boolean) => void;
  /** 未通过审核时的两个出口：宿主不给就不渲染那颗按钮（后端还没有端点时，给了也只是回执） */
  onAppeal?: () => void;
  onResubmit?: () => void;

  // —— 评论 ——
  comments: CommentData[];
  commentTotal: number;
  candidates: MentionCandidate[];
  /** 提及时**已经打出来的那串字**（敲 @ 之后每变一次报一次，空串 = 查询关了）。
   *  为什么向上报而不是在这一层取：候选要打端点，而组件不认识 lib/api（依赖方向 §4.1）——
   *  宿主拿这个词去查，再把结果从 candidates 传回来。 */
  onMentionQuery?: (q: string) => void;
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
  /** 作者的打赏提示文案（user_donation_settings.notice_text；后端没有「每渠道一句」这一列） */
  channelNotice?: string;
  /** 打赏位：作者本人不显示（后端拒绝自己给自己打赏） */
  donateIsSelf?: boolean;
  /** 本人时「去我的主页挂码」的去处（D22：收款码的管理界面在个人主页右栏那个弹层里） */
  donateProfileHref?: string;
  onDonate?: (v: { channelId: string; amountCents: number }) => void;
  donatePending?: boolean;
  donateError?: string | null;
  donateDone?: string | null;
  donateLoginHref?: string;
  donateLoggedIn?: boolean;
  issueCount: number;
  /** 反馈页的地址；还没有那一页时改给 onOpenFeedback（点一下有回执，不留 404 死链） */
  feedbackHref?: string;
  /** 四个类型入口各自的地址（带上 kind）。给了它就优先于 feedbackHref —— 那样每个入口才预设得上自己的类型 */
  issueHrefFor?: (kind: IssueKind) => string;
  onOpenFeedback?: (kind?: IssueKind) => void;
  /** 「问题反馈」页签的落点（**宿主必须接**）。
   *  D5（2026-10-14 用户实测）：原先它默认 noop —— 点页签什么都没发生，人还以为页签坏了。
   *  这里不自己导航（组件不认识路由），但宿主不接时也不静默：见下面 TopicTaskTabs 的兜底。 */
  onOpenIssue?: () => void;

  // —— 下载来源能不能点（房间没有转链端点）——
  sourcesLinked?: boolean;
  /** 动作回执：由宿主持有（房间是本地状态，真站是请求结果） */
  receipt?: ReactNode;
  /** 初值：只给出图脚本用（房间 ?open=report|edit 直接拍到交互态），真站不传 */
  initialLayer?: 'report' | 'edit' | 'delete' | null;
};

export function TopicView({
  boards,
  boardLink,
  board,
  boardNav,
  boardHref,
  navValue,
  onNavChange,
  composeHref,
  onJoin,
  authorHref,
  author,
  authorFollow,
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
  editHref,
  onSubmitReport,
  reported,
  reportedIds,
  onDelete,
  deleting = false,
  pinOn,
  featureOn,
  pinPending,
  onTogglePin,
  onToggleFeature,
  onAppeal,
  onResubmit,
  comments,
  commentTotal,
  candidates,
  onMentionQuery,
  me,
  newSeqs,
  onSubmitComment,
  onDeleteComment,
  onVoteComment,
  replyPrompt,
  commentsFallback,
  channels,
  channelNotice,
  donateIsSelf = false,
  donateProfileHref,
  onDonate,
  donatePending,
  donateError,
  donateDone,
  donateLoginHref,
  donateLoggedIn = false,
  issueCount,
  feedbackHref,
  issueHrefFor,
  onOpenFeedback,
  onOpenIssue,
  sourcesLinked = false,
  receipt,
  initialLayer = null,
}: TopicViewProps) {
  const [tab, setTab] = useState<TopicTaskTab>('content');
  // 弹层与确认：只开一个（举报 / 编辑 / 删帖三件事各是各的，同时开着人不知道自己在确认什么）
  const [layer, setLayer] = useState<'report' | 'edit' | 'delete' | null>(initialLayer);
  // L6：打回修改时那份「最后过审版本」的弹层。与举报/编辑/删除同一套「只开一个」的规矩，
  // 但它不改任何东西（纯只读的参照），所以不放进 layer 那个联合类型里。
  const [revisionOpen, setRevisionOpen] = useState(false);
  // 举报对象：null = 帖子本身，非 null = 某条回复（回复级举报带 target_type=post）
  const [reportTarget, setReportTarget] = useState<{ id: string; label: string } | null>(null);

  const rejected = review.state === 'rejected';

  function openReport(target: { id: string; label: string } | null) {
    setReportTarget(target);
    setLayer('report');
  }

  return (
    <div className='flex w-full flex-col gap-4'>
      <TopicTaskTabs
        value={tab}
        onChange={setTab}
        issueCount={issueCount}
        // D5：页签是**受控**的，切过去靠宿主导航（房间指房间里的反馈页，真站指 /issues?topic=）。
        // 宿主没接时退回「选中它」——至少页签会动，而不是点下去一片死寂（那正是用户报的现象）。
        onOpenIssue={onOpenIssue ?? (() => setTab('issue'))}
      />

      <div className='grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-[minmax(0,1fr)_248px] xl:flex xl:items-start'>
        {/* 左栏：只在 ≥1200px 出现。用 hidden 而不是挪到底部——它是「常驻栏」，不该在窄屏抢首屏 */}
        <aside aria-label='分区与分区内导航' className='hidden xl:block xl:w-[200px] xl:shrink-0'>
          <LeftRail
            boards={boards}
            currentSlug={board.slug}
            nav={boardNav}
            navValue={navValue}
            onNavChange={onNavChange}
            link={boardLink}
          />
        </aside>

        {/* 中栏：主区。窄屏靠 row-start 抢回第一格，右栏因此落在它下面、评论之前 */}
        <main data-testid='topic-main' className='flex min-w-0 flex-col gap-3 md:col-start-1 md:row-start-1 xl:flex-1'>
          <TopicMeta topic={topic} boardHref={boardHref(board.slug)} />
          <MainColumn
            topic={topic}
            authorHref={authorHref}
            comments={comments}
            commentTotal={commentTotal}
            candidates={candidates}
            me={me}
            issues={
              <IssueNudge
                issueCount={issueCount}
                href={feedbackHref}
                kindHref={issueHrefFor}
                onOpen={feedbackHref ? undefined : onOpenFeedback}
              />
            }
            reviewState={review.state}
            reviewPendingHuman={review.pendingHuman ?? false}
            reviewResubmitted={review.resubmitted ?? false}
            reviewRevision={review.revision ? <ReviewRevisionButton onOpen={() => setRevisionOpen(true)} /> : null}
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
            editHref={canEdit && editHref ? editHref(topic.id) : undefined}
            onDelete={onDelete ? () => setLayer('delete') : undefined}
            pinOn={pinOn}
            featureOn={featureOn}
            pinPending={pinPending}
            onTogglePin={onTogglePin}
            onToggleFeature={onToggleFeature}
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
            onMentionQuery={onMentionQuery}
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
          <AuthorCard author={author} profileHref={authorHref} follow={authorFollow} />
          <RewardPanel
            channels={channels}
            notice={channelNotice}
            isSelf={donateIsSelf}
            profileHref={donateProfileHref}
            onDonate={onDonate}
            donationPending={donatePending}
            donationError={donateError}
            donationDone={donateDone}
            loginHref={donateLoginHref}
            loggedIn={donateLoggedIn}
          />
          <IssueNudge
            variant='rail'
            issueCount={issueCount}
            href={feedbackHref}
            kindHref={issueHrefFor}
            onOpen={feedbackHref ? undefined : onOpenFeedback}
          />
        </aside>
      </div>

      {/* L6：最后过审版本的只读弹层。与举报/编辑一样挂在页面级（Dialog 自己进 portal），
          但**不在 layer 那个联合里** —— 它不改任何东西，同时开着也不冲突。 */}
      {revisionOpen && review.revision ? (
        <RevisionDialog revision={review.revision} onClose={() => setRevisionOpen(false)} />
      ) : null}
    </div>
  );
}

// toText（把 content_html 剥成纯文本）已删：它服务的是「编辑框是纯文本框」的那个旧形态。
// 编辑的初值现在是 content_md（EditorState JSON），从 HTML 反推既会丢提及的 userId
// 与图片节点，也与「后端存的是 JSON」这个事实对不上（拍板 08 §第三轮 5）。
