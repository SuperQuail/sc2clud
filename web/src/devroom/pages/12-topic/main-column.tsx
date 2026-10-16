import { Suspense, lazy, type ReactNode } from 'react';
import { UserBadge } from '@/ui/user/user-badge';
import type { CommentData } from '@/ui/comment/types';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import { FeaturedFlag, KindTag, PinnedFlag, RepostSource } from './badges';
import { ResourceSources, UpkeepNote } from './resource-sources';
import { ReviewStateBanner, type ReviewState } from './review-state';
import { TopicActions } from './topic-actions';
import { TopicBody } from './topic-body';
import type { TopicDetail } from './types';

// 评论区按模块加载：TopicComments → ReplyBox → MarkdownEditor（Lexical，gzip 约 100KB）。
// 帖子正文与标题必须立刻出现（前端方案 §6：帖子页是公开首屏），所以编辑器不能进首屏包。
// 这一层 lazy **必须留在 MainColumn 里**：房间与真站共用同一个组合点，
// 谁把 TopicComments 改成静态 import，谁就把 Lexical 拖回首屏（体积门禁会挡）。
const LazyComments = lazy(() => import('./topic-comments').then((m) => ({ default: m.TopicComments })));

// 中栏 = 一个帖子的全文：标题与标记 → 作者行 → 正文 → 资源来源 → 动作条 → 评论区。
// 顺序不是随便排的：**读者要的东西按「这是什么 / 谁写的 / 写了什么 / 怎么拿到 / 我怎么反应 / 别人怎么说」降序**，
// 所以下载来源必须在评论区之前——资源帖里它比评论重要。
//
// **数据与状态一律由宿主给**（房间用本地 state，真站用 react-query）：
// 点赞/收藏是受控的（原来是组件内部 useState，服务端真值一到就会与它分叉），
// 问题反馈块与删除确认是插槽（房主知道自己在哪个环境里有什么可用）。
export function MainColumn({
  topic,
  comments,
  commentTotal,
  candidates,
  onMentionQuery,
  me,
  issues,
  reviewState = 'approved',
  reviewNote,
  reviewAppeal,
  reviewResubmit,
  reviewPendingHuman = false,
  reviewResubmitted = false,
  reviewRevision,
  reported = false,
  reportDialog,
  deleteConfirm,
  receipt,
  canEdit = false,
  liked,
  bookmarked,
  likeCount,
  bookmarkCount,
  onToggleLike,
  onToggleBookmark,
  onCopyLink,
  onReport,
  editHref,
  onDelete,
  /** 版主的两颗开关（D73）：原样传给动作条（渲染与否在那层按「回调给了没有」判） */
  pinOn,
  featureOn,
  pinPending,
  onTogglePin,
  onToggleFeature,
  onVote,
  onDeleteComment,
  onSubmitComment,
  reportedIds,
  onReportComment,
  newSeqs,
  replyPrompt,
  commentsFallback,
  sourcesLinked = false,
  authorHref,
}: {
  topic: TopicDetail;
  comments: CommentData[];
  commentTotal: number;
  candidates: MentionCandidate[];
  /** 提及时已经打出来的那串字：向上报给宿主，由它去打候选端点（组件不认识 lib/api） */
  onMentionQuery?: (q: string) => void;
  me: { nickname: string; avatar?: string | null; handle: string };
  /** 正文末尾的问题反馈入口（房间指房间里的反馈页，真站指线上或给回执）：由宿主给，位置由这里定 */
  issues?: ReactNode;
  /** 审核态：作者视角的三个值（d7 §1）。approved 是默认——正常帖什么都不显示 */
  reviewState?: ReviewState;
  /** topics.review_note：AI 给的中文理由，**只有 rejected 才有值** */
  reviewNote?: string | null;
  /** 「申请人工复核」按钮（rejected 时才给）：横幅只摆位置，动作由页面接 */
  reviewAppeal?: ReactNode;
  /** 「重新提交审核」按钮（rejected 时才给）：与「改完可以重新提交」那句话成对出现 */
  reviewResubmit?: ReactNode;
  /** 后端 review_pending_human：pending 是否已转人工（决定两档文案） */
  reviewPendingHuman?: boolean;
  /** L7：这一次 pending 是作者改完正文重提上来的（同一 state 下的另一档文案） */
  reviewResubmitted?: boolean;
  /** L6：打回修改时的「查看最后过审版本」入口（按钮 + 弹层都由宿主给） */
  reviewRevision?: ReactNode;
  /** 举报过这篇帖子：动作条上的按钮变「已举报」 */
  reported?: boolean;
  /** 举报弹层与删除确认（受控），由页面给；**编辑不再是弹层**（2026-10-15：编辑复用发帖页） */
  reportDialog?: ReactNode;
  deleteConfirm?: ReactNode;
  /** 动作回执（分享已复制 / 举报已提交 / 已发布…）：紧跟动作条 */
  receipt?: ReactNode;
  /** 权限点 post.update_own（作者本人）——决定渲染不渲染「编辑」 */
  canEdit?: boolean;
  liked: boolean;
  bookmarked: boolean;
  likeCount: number;
  bookmarkCount?: number;
  onToggleLike?: () => void;
  onToggleBookmark?: () => void;
  onCopyLink?: () => void;
  onReport?: () => void;
  /** 编辑跳发帖页：宿主注入的落地地址（产品 /new?edit=…；房间 ?page=18-compose&edit=…） */
  editHref?: string;
  /** 删帖（与删回复是两个动作）：不传就不渲染这颗按钮 */
  onDelete?: () => void;
  /** 版主的两颗开关（D73）：含义与渲染规则见 TopicActions */
  pinOn?: boolean;
  featureOn?: boolean;
  pinPending?: boolean;
  onTogglePin?: (next: boolean) => void;
  onToggleFeature?: (next: boolean) => void;
  onVote: (id: string, value: 1 | -1) => void;
  /** 删回复（不是删帖）：parentId 非空表示它长在哪个主楼下 */
  onDeleteComment: (parentId: string | null, id: string) => void;
  onSubmitComment: (parentId: string | null, body: { json: string; html: string }) => void;
  reportedIds: string[];
  onReportComment: (target: { id: string; label: string }) => void;
  /** 新发的评论序号（id → seq）：新回复置顶与「最新」排序要用 */
  newSeqs?: Record<string, number>;
  /** 登录 / 发帖权限不够时替换掉所有回复输入框的那一块（未登录也要能看见评论区） */
  replyPrompt?: ReactNode;
  /** 评论还没到 / 拿不到时替换整个评论区的那一块（给了它就不加载评论区模块，省掉一次 Lexical 下载） */
  commentsFallback?: ReactNode;
  /** 下载来源能不能点：房间没有转链端点，真站有 */
  sourcesLinked?: boolean;
  /** 发帖者主页地址（D8：作者名与头像都要能点进去） */
  authorHref: string;
}) {
  return (
    <div className='flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-5'>
      <header className='flex flex-col gap-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <KindTag kind={topic.kind} />
          {topic.pinned ? <PinnedFlag /> : null}
          {topic.featured ? <FeaturedFlag /> : null}
          {topic.kind === 'repost' ? <RepostSource from='NGA 星际争霸版' /> : null}
        </div>
        <h1 className='text-[19px] leading-snug font-semibold break-words text-foreground sm:text-[22px]'>
          {topic.title}
        </h1>
        {/* 审核态横幅紧贴标题：它是「这篇现在是什么状态」，不是正文的一部分。
            非作者收不到 pending/rejected 的帖子（后端过滤），所以这里不需要「游客看到审核中」的分支。 */}
        <ReviewStateBanner
          state={reviewState}
          note={reviewNote}
          appeal={reviewAppeal}
          resubmit={reviewResubmit}
          pendingHuman={reviewPendingHuman}
          resubmitted={reviewResubmitted}
          revisionView={reviewRevision}
        />
        <div className='border-b border-border pb-3'>
          {/* D8：头像与昵称**都能点进主页** —— 点不动就没法从帖子页走到某个人的主页，
              私信/查看 TA 的帖子这些下游功能因此整条测不了。链接由宿主给（组件不认识路由）。 */}
          <a
            href={authorHref}
            title={'查看 ' + topic.author.nickname + ' 的主页'}
            className='inline-flex rounded-[3px] outline-none hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            <UserBadge
              user={{ handle: topic.author.handle, nickname: topic.author.nickname, avatar: topic.author.avatar, role: topic.author.role, title: topic.author.title }}
              size='md'
              showHandle
            />
          </a>
        </div>
      </header>

      {/* 下载来源在正文**上方**（D4，2026-10-14 用户实测）：资源帖的读者第一件事就是「去哪下」，
          滚到正文末尾才看到它等于没有。守护说明跟在来源后面（它说的是来源的维护状态）。 */}
      {topic.sources.length > 0 ? (
        <div className='flex flex-col gap-2'>
          <ResourceSources sources={topic.sources} linked={sourcesLinked} />
          <UpkeepNote updatedAt={topic.updated_at} />
        </div>
      ) : null}

      <TopicBody contentHtml={topic.content_html} />

      {/* 正文末尾的反馈入口：正文与评论之间，读者读完正文正好接住。
          四类反馈按钮就在这里（普通用户不认识「Issue」，所以不给黑话入口）。 */}
      {issues}

      <TopicActions
        liked={liked}
        bookmarked={bookmarked}
        likeCount={likeCount}
        bookmarkCount={bookmarkCount}
        replyCount={topic.reply_count}
        viewCount={topic.view_count}
        reported={reported}
        onToggleLike={onToggleLike}
        onToggleBookmark={onToggleBookmark}
        onCopyLink={onCopyLink}
        onReport={onReport}
        editHref={canEdit ? editHref : undefined}
        onDelete={onDelete}
        pinOn={pinOn}
        featureOn={featureOn}
        pinPending={pinPending}
        onTogglePin={onTogglePin}
        onToggleFeature={onToggleFeature}
        designNote={receipt}
        deleteConfirm={deleteConfirm}
      />

      {commentsFallback ?? (
        <Suspense fallback={<p className='text-[13px] text-muted-foreground'>正在加载评论区…</p>}>
          <LazyComments
            comments={comments}
            total={commentTotal}
            me={me}
            candidates={candidates}
            onMentionQuery={onMentionQuery}
            onSubmit={onSubmitComment}
            onVote={onVote}
            onDelete={onDeleteComment}
            reportedIds={reportedIds}
            onReport={onReportComment}
            newSeqs={newSeqs}
            receipt={receipt}
            replyPrompt={replyPrompt}
          />
        </Suspense>
      )}

      {reportDialog}
    </div>
  );
}

/** 帖子底部那行「所属分区 / 发布时间 / 最后编辑」——放在动作条上方太抢，放在标题下太挤，所以贴在正文头。 */
export function TopicMeta({ topic, boardHref }: { topic: TopicDetail; boardHref: string }) {
  return (
    <p className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground'>
      <span>发布于 {topic.created_at}</span>
      {topic.updated_at !== topic.created_at ? <span>· 最后编辑 {topic.updated_at}</span> : null}
      <a
        href={boardHref}
        className='rounded-[3px] outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
      >
        {topic.board.name}
      </a>
      <span>· 帖子 #{topic.id}</span>
      {topic.locked ? <span className='text-destructive'>· 已锁定，仅可浏览</span> : null}
    </p>
  );
}
