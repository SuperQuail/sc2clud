import { useState, type ReactNode } from 'react';
import { appPath } from '@/lib/url';
import { CommentList } from '@/ui/comment/comment-list';
import { ReplyBox } from '@/ui/comment/reply-box';
import { UserBadge } from '@/ui/user/user-badge';
import type { CommentData } from '@/ui/comment/types';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import { FeaturedFlag, KindTag, PinnedFlag, RepostSource } from './badges';
import { IssueNudge } from './issue-nudge';
import { ResourceSources, UpkeepNote } from './resource-sources';
import { ReviewStateBanner, type ReviewState } from './review-state';
import { TopicActions } from './topic-actions';
import { TopicBody } from './topic-body';
import type { TopicDetail } from './types';

// 中栏 = 一个主题的全文：标题与标记 → 作者行 → 正文 → 资源来源 → 动作条 → 评论区。
// 顺序不是随便排的：**读者要的东西按「这是什么 / 谁写的 / 写了什么 / 怎么拿到 / 我怎么反应 / 别人怎么说」降序**，
// 所以下载来源必须在评论区之前——资源帖里它比评论重要。
export function MainColumn({
  topic,
  comments,
  commentTotal,
  candidates,
  me,
  issueCount,
  reviewState = 'approved',
  reviewNote,
  reviewAppeal,
  reviewPendingHuman = false,
}: {
  topic: TopicDetail;
  comments: CommentData[];
  commentTotal: number;
  candidates: MentionCandidate[];
  me: { nickname: string; avatar?: string | null };
  issueCount: number;
  /** 审核态：作者视角的三个值（d7 §1）。approved 是默认——正常帖什么都不显示 */
  reviewState?: ReviewState;
  /** topics.review_note：AI 给的中文理由，**只有 rejected 才有值** */
  reviewNote?: string | null;
  /** 「申请人工复核」按钮（rejected 时才给）：横幅只摆位置，动作由页面接 */
  reviewAppeal?: ReactNode;
  /** 后端 review_pending_human：pending 是否已转人工（决定两档文案） */
  reviewPendingHuman?: boolean;
}) {
  const [liked, setLiked] = useState(topic.viewer.liked);
  const [bookmarked, setBookmarked] = useState(topic.viewer.bookmarked);
  const likeCount = topic.like_count + (liked === topic.viewer.liked ? 0 : liked ? 1 : -1);
  const bookmarkCount = topic.bookmark_count + (bookmarked === topic.viewer.bookmarked ? 0 : bookmarked ? 1 : -1);

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
            非作者收不到 pending/rejected 的主题（后端过滤），所以这里不需要「游客看到审核中」的分支。 */}
        <ReviewStateBanner
          state={reviewState}
          note={reviewNote}
          appeal={reviewAppeal}
          pendingHuman={reviewPendingHuman}
        />
        <div className='border-b border-border pb-3'>
          <UserBadge
            user={{ handle: topic.author.handle, nickname: topic.author.nickname, avatar: topic.author.avatar, role: topic.author.role, title: topic.author.title }}
            size='md'
            showHandle
          />
        </div>
      </header>

      <TopicBody contentHtml={topic.content_html} />

      {topic.sources.length > 0 ? (
        <div className='flex flex-col gap-2'>
          <ResourceSources sources={topic.sources} />
          <UpkeepNote updatedAt={topic.updated_at} />
        </div>
      ) : null}

      {/* 正文末尾的反馈入口：正文与评论之间，读者读完正文正好接住。
          四类反馈按钮就在这里（普通用户不认识「Issue」，所以不给黑话入口）。 */}
      <IssueNudge issueCount={issueCount} />

      <TopicActions
        liked={liked}
        bookmarked={bookmarked}
        likeCount={likeCount}
        bookmarkCount={bookmarkCount}
        replyCount={topic.reply_count}
        viewCount={topic.view_count}
        onToggleLike={() => setLiked((v) => !v)}
        onToggleBookmark={() => setBookmarked((v) => !v)}
      />

      {/* 空态：没有回复时**输入框仍然在**（人来了就能写），只是列表位置给一句解释。
          CommentList 自带表头与输入框，所以空态是包在它外面的一层，不是换掉它。 */}
      {comments.length === 0 ? (
        <section className='flex flex-col gap-5'>
          <h2 className='text-lg font-semibold text-foreground'>评论 0</h2>
          <ReplyBox me={me} candidates={candidates} />
          <p className='rounded-lg border border-dashed border-border px-3 py-6 text-center text-[13px] text-muted-foreground'>
            还没有人回复。玩法与设计的问题直接在这下面问；卡住、崩溃、难度不合适请走上面的反馈入口。
          </p>
        </section>
      ) : (
        <CommentList comments={comments} total={commentTotal} me={me} candidates={candidates} />
      )}
    </div>
  );
}

/** 帖子底部那行「所属分区 / 发布时间 / 最后编辑」——放在动作条上方太抢，放在标题下太挤，所以贴在正文头。 */
export function TopicMeta({ topic }: { topic: TopicDetail }) {
  return (
    <p className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground'>
      <span>发布于 {topic.created_at}</span>
      {topic.updated_at !== topic.created_at ? <span>· 最后编辑 {topic.updated_at}</span> : null}
      <a
        href={appPath('b/' + topic.board.slug)}
        className='rounded-[3px] outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
      >
        {topic.board.name}
      </a>
      <span>· 主题 #{topic.id}</span>
      {topic.locked ? <span className='text-destructive'>· 已锁定，仅可浏览</span> : null}
    </p>
  );
}
