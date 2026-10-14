import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { can, useSession } from '@/lib/perms';
import { isApiError } from '@/lib/api/errors';
import {
  createPost,
  createReport,
  deletePost,
  deleteTopic,
  fetchBoards,
  fetchPosts,
  fetchTopic,
  setPostVote,
  setTopicBookmark,
  setTopicLike,
  updateTopic,
  type Board as ApiBoard,
  type ReportReason,
  type TopicDetail as ApiTopicDetail,
  type TopicSource as ApiSource,
} from '@/lib/api/forum';
import { fetchUserProfile, searchUsers, type UserProfile } from '@/lib/api/user';
import { createDonation, fetchUserChannels } from '@/lib/api/rewards';
import { fetchBoardFollow, followBoard, unfollowBoard } from '@/lib/api/follow';
import { formatCents, formatTime } from '@/lib/format';
import { DesignActionNote } from '@/devroom/pages/12-topic/design-action';
import { TopicView, type TopicReview } from '@/devroom/pages/12-topic/topic-view';
import type {
  Board,
  BoardNav,
  BoardSlug,
  TopicAuthor,
  TopicDetail,
  TopicSource,
} from '@/devroom/pages/12-topic/types';
import { ErrorState, Loading } from './_parts/state';
import { imageUrl, toComments } from './_parts/mappers';

// 帖子详情 + 回复（契约：GET /topics/{id}、GET /topics/{id}/posts、POST /topics/{id}/posts）。
// **公开首屏，不做代码分割**（前端方案 §6：它是从搜索引擎直接落地的页面）。
//
// 版面**一格都不是这一页画的**：整屏来自 @/devroom/pages/12-topic/topic-view（与 DevRoom 12 同一份代码）。
// 这里只做三件事：
//   ① 取数据（主题 / 回复 / 分区表 / 作者资料）；
//   ② 把接口形状**逐字段**对成设计件吃的形状（字段名照 forum/internal/forum/dto.go 抄）；
//   ③ 把每个动作接到真端点上（点赞 / 收藏 / 举报 / 编辑 / 回复 / 删回复 / 删帖）。
// 为什么要有 ②：设计件吃的是「展示用的形状」（时间已是展示串、来源已归一），接口给的是线格式；
// 两侧都不该为了对方改签名 —— 转换只在这一层（与 _parts/mappers.ts 同一个理由）。

/** 后端详情里 lib/api/forum.ts 的 TopicDetail **还没声明**的审核/反馈态字段（照 forum/internal/forum/dto.go 抄）。
 *  头像与 cover 原先也在这张表里（当年 lib/api/forum 还停在设计稿的名字上）—— 2026-10-14 那边改成
 *  DTO 真名之后，本类型只剩这几个真没声明的。 */
type TopicWire = {
  review_state?: string;
  review_note?: string | null;
  issue_open_count?: number;
  can_edit?: boolean;
  can_reply?: boolean;
  /** L6：只有 `revision_requested`（打回修改）时才有值 —— 上一份**过审的**正文（forum/map.go:77）。 */
  revision_of?: { content_md: string; content_html: string; approved_at: string } | null;
};

/** 分区内导航：后端只有 kind 这一个筛选（featured / announcement 两个筛选没有端点，routes/board.tsx 同一处缺口），
 *  而且**没有「每个筛选各多少帖」的计数** —— 所以真站只给四项，且不带数字（给了 0 会被当成「这里没有帖子」）。 */
const BOARD_NAV: BoardNav[] = [
  { key: '', label: '全部' },
  { key: 'discussion', label: '讨论' },
  { key: 'resource', label: '资源' },
  { key: 'repost', label: '转载' },
];

export function TopicPage() {
  const { topicId = '' } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const queryClient = useQueryClient();

  const [receipt, setReceipt] = useState<string | null>(null);
  // 举报过的东西（帖子级 + 回复级）：后端幂等（重复举报回 200 + 既有那条），这一份只影响「已举报」怎么显示
  const [reported, setReported] = useState(false);
  const [reportedIds, setReportedIds] = useState<string[]>([]);

  const topic = useQuery({
    queryKey: qk.topic(topicId),
    queryFn: ({ signal }) => fetchTopic(topicId, signal),
    enabled: topicId !== '',
    staleTime: 60_000,
  });
  const posts = useQuery({
    queryKey: qk.posts(topicId),
    queryFn: ({ signal }) => fetchPosts(topicId, {}, signal),
    staleTime: 30_000,
    enabled: topicId !== '',
  });
  // 左栏的分区列表：与首页/分区页共用 qk.boards() 那一份缓存（staleTime 10 分钟在 lib/query/client.ts 里定）
  const boards = useQuery({
    queryKey: qk.boards(),
    queryFn: ({ signal }) => fetchBoards(signal),
    staleTime: 10 * 60_000,
  });

  // 作者与分区要先取出来：下面两条依赖它们的查询（作者资料 / 关注状态）都在 hooks 层，
  // 而 hooks 的顺序不能有分支 —— 这两个值从主题详情里读，没到就是空串（查询自己 enabled 挡着）。
  const authorHandle = topic.data?.author.handle ?? '';
  const boardSlug = topic.data?.board.slug ?? '';

  // 左栏那一格「成员」与「关注分区」（拍板 08 · L5 收尾；端点是 K-REL 做的关注域）。
  // **两次一取**：GET /boards/{slug}/follow 同时给出「我关没关注」与「被关注数」，
  // 而 BoardDTO 里没有这一列（member_count 从来就不是后端的字段）—— 所以这一格的真数来自这里，
  // 不是从 boards 列表推的。与分区页 routes/board.tsx 用同一个 qk.followBoard()：
  // 同一分区在两页之间来回走不会各拉一次、也不会一页已关注另一页还没跟上。
  // 未登录也能读（following 恒 false、关注数照给）——「关注数」不是登录者专属信息。
  const boardFollow = useQuery({
    queryKey: qk.followBoard(boardSlug),
    queryFn: ({ signal }) => fetchBoardFollow(boardSlug, signal),
    enabled: boardSlug !== '',
    staleTime: 60_000,
  });
  const toggleFollow = useMutation({
    mutationFn: (on: boolean) => (on ? followBoard(boardSlug) : unfollowBoard(boardSlug)),
    // 幂等且回执就是同一份 State，所以直接写进缓存，不回读一次（与 routes/board.tsx 同款）
    onSuccess: (state) => queryClient.setQueryData(qk.followBoard(boardSlug), state),
  });

  // 作者卡片的等级 / 经验 / 头衔只有 /users/{handle} 有（主题详情的 author 只有 handle/nickname/bio/level/joined_at）
  const authorProfile = useQuery({
    queryKey: qk.profile(authorHandle),
    queryFn: ({ signal }) => fetchUserProfile(authorHandle, signal),
    enabled: authorHandle !== '',
    staleTime: 60_000,
  });

  // 打赏（L1）：右栏那一格的收款码来自 GET /users/{handle}/channels（reward 域）。
  // 作者关掉「展示收款码」时后端回**空数组** —— 那时展开是「作者还没开启收款码」，不是一块假区域。
  const authorChannels = useQuery({
    queryKey: qk.userChannels(authorHandle),
    queryFn: ({ signal }) => fetchUserChannels(authorHandle, signal),
    enabled: authorHandle !== '',
    staleTime: 60_000,
  });
  // 打赏申报（POST /rewards）：这是**登记**不是付款 —— 钱扫码直接给作者，站点不经手资金。
  const donate = useMutation({
    mutationFn: (v: { channelId: string; amountCents: number }) =>
      createDonation({ to_handle: authorHandle, amount_cents: v.amountCents, channel_id: v.channelId, post_id: topicId }),
  });

  // ---- 动作 ----
  const like = useMutation({
    mutationFn: (on: boolean) => setTopicLike(topicId, on),
    // 幂等开关才允许乐观更新（前端方案 §5.3）；失败由 useMutation 报错，界面回到服务端值
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.topic(topicId) }),
  });
  const bookmark = useMutation({
    mutationFn: (on: boolean) => setTopicBookmark(topicId, on),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.topic(topicId) }),
  });
  const vote = useMutation({
    // value=0 是「取消」，后端是 DELETE —— 同向再点一次就取消（幂等）
    mutationFn: (v: { id: string; value: 1 | -1; on: boolean }) => setPostVote(v.id, v.on ? 0 : v.value),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.posts(topicId) }),
  });
  const reply = useMutation({
    mutationFn: (v: { parentId: string | null; body: { json: string; html: string } }) =>
      createPost(topicId, { content_md: v.body.json, parent_id: v.parentId ?? undefined }),
    onSuccess: () => {
      // 回复成功后失效「回复列表 + 主题」（主题的 reply_count 会变）——按影响面失效，不全量 invalidate
      void queryClient.invalidateQueries({ queryKey: qk.posts(topicId) });
      void queryClient.invalidateQueries({ queryKey: qk.topic(topicId) });
    },
  });
  const removeReply = useMutation({
    mutationFn: (id: string) => deletePost(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.posts(topicId) });
      void queryClient.invalidateQueries({ queryKey: qk.topic(topicId) });
      setReceipt('这条回复已删除。');
    },
  });
  const report = useMutation({
    mutationFn: (v: { target_type: 'topic' | 'post'; target_id: string; reason: ReportReason; detail?: string }) =>
      createReport(v),
    onSuccess: (_created, v) => {
      if (v.target_type === 'topic') setReported(true);
      else setReportedIds((ids) => (ids.includes(v.target_id) ? ids : [...ids, v.target_id]));
      setReceipt('举报已提交，进入「举报处理」队列（待处理）。你可以在「我的举报」里跟进。');
    },
  });
  // 改过正文之后审没审过就作废了：后端的 PATCH 只要带 content_md 就把 review_state 打回 pending
  // （forum/internal/forum/service.go 的 ResetTopicReview，597c4ac 修的）——所以「保存」=「重新提交审核」，
  // 两件事是同一次请求。saved 只用来在回执里说实话，不参与渲染判断。
  const [saved, setSaved] = useState<'idle' | 'draft' | 'resubmitted'>('idle');
  const save = useMutation({
    mutationFn: (next: { title: string; text: string }) =>
      updateTopic(topicId, { title: next.title, content_md: next.text }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.topic(topicId) });
      void queryClient.invalidateQueries({ queryKey: qk.posts(topicId) });
      setSaved('draft');
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteTopic(topicId),
    onSuccess: () => {
      // qk.topics 是**工厂函数**不是数组，所以这里用字面前缀失效（react-query 按前缀匹配）。
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
      void navigate(boardSlug ? appPath('b/' + encodeURIComponent(boardSlug)) : appPath(''), { replace: true });
    },
  });

  if (topic.isPending) return <Loading what='帖子' />;
  if (topic.isError) {
    return (
      <ErrorState
        what={isApiError(topic.error) && topic.error.status === 404 ? '帖子' : '帖子详情'}
        error={topic.error}
        onRetry={() => void topic.refetch()}
      />
    );
  }

  const t = topic.data;
  const ap = authorProfile.data;
  // 本页要用、而 lib/api/forum.ts 还没声明的几个字段（can_reply / can_edit / issue_open_count）
  const wire = t as ApiTopicDetail & TopicWire;

  // ---- 接口形状 → 设计件的形状 ----
  const allBoards = (boards.data ?? []).map(toDesignBoard);
  const current = allBoards.find((b) => b.slug === boardSlug);
  // 分区列表没回来也要能画这一页：用主题自带的两字段兜一个最小 Board，统计先空着（不假装有数）。
  // 「成员」与「已关注」**一律取关注状态那一份**（列表项里没有这两列，boardFollow 才是真源）：
  // 它没回来时是 0 / false —— 那是「还没问到」，不是「这里没人关注」。
  const base: Board = current ?? {
    slug: boardSlug as BoardSlug,
    name: t.board.name,
    cover: '',
    description: '',
    topic_count: 0,
    post_count: 0,
    member_count: 0,
    today_count: 0,
    joined: false,
    hint: '',
  };
  const designBoard: Board = {
    ...base,
    member_count: boardFollow.data?.follower_count ?? 0,
    joined: boardFollow.data?.following ?? false,
  };
  const designAuthor = toDesignAuthor(t, ap);
  // 回执要说实话：改过正文之后，帖子是「已重新提交、正在重审」，还是只是被保存了？
  //   reset：这次保存把 rejected 打回了 pending（服务端事实，不是推断——见上面 ResetTopicReview）。
  //   still：正文改过了但服务端仍说 rejected（还没生效或这版没过），就别谎称已经重新提交。
  const justSaved = saved === 'draft';
  // L7：把「这一次 pending 是重提上来的」也交给横幅 —— 作者刚按下保存，回执与页头横幅说同一件事。
  // shortcut: 只看**本次会话里的保存**（刷新后 pending 与首次投稿同形，界面上分不出来）——
  //   要跨刷新区分得让后端在上传时记一笔（例如 topics.review_resubmitted_at），那是变更单里的事。
  const reviewReset = justSaved && wire.review_state === 'pending';
  const review = reviewReset ? { ...toReview(t), resubmitted: true } : toReview(t);
  const receiptText = justSaved
    ? reviewReset
      ? '已保存 · 正文改动已重新提交审核（回到「审核中」），通过后其他人才能看到。'
      : '已保存 · 标题与正文都更新了。'
    : receipt;

  const comments = toComments(posts.data?.items ?? []);
  const loggedIn = session.isLoggedIn;
  const me = { handle: session.session?.handle ?? '', nickname: session.session?.nickname ?? '', avatar: session.session?.avatar ?? null };
  // 能不能回复 / 编辑以后端算的 can_reply / can_edit 为准（它认 activation、分区 ACL、锁定），前端权限只兜底
  const canReply = wire.can_reply ?? (loggedIn && can(session.session, 'topic.create'));
  const canEdit = wire.can_edit ?? (loggedIn && t.author.handle === me.handle && can(session.session, 'topic.edit.own'));
  const designTopic = toDesignTopic(t, designAuthor);

  // 动作失败不许静默：哪一步错了，就把那一步的名字与错误显示在动作条下面（receipt 那个位置）
  const steps: Array<{ what: string; m: { isError: boolean; error: unknown } }> = [
    { what: '删除帖子', m: remove },
    { what: '发回复', m: reply },
    { what: '举报', m: report },
    { what: '保存', m: save },
    { what: '删除回复', m: removeReply },
    { what: '投票', m: vote },
    { what: '点赞', m: like },
    { what: '收藏', m: bookmark },
  ];
  const failed = steps.find((s) => s.m.isError) ?? null;

  return (
    <TopicView
      boards={allBoards}
      board={designBoard}
      boardNav={BOARD_NAV}
      boardHref={boardHref}
      navValue=''
      onNavChange={(key) => {
        // 分区内导航是**分区列表的筛选**（design types.ts：URL 上的 kind 组合），所以它把人带回分区页并带上筛选
        const to = key
          ? routePath('b/' + encodeURIComponent(boardSlug) + '?kind=' + key)
          : routePath('b/' + encodeURIComponent(boardSlug));
        void navigate(to);
      }}
      composeHref={appPath('new?board=' + encodeURIComponent(boardSlug))}
      // 关注分区那条注释已过时（K-REL 的关注域早就把端点做完了）——现在点它是真请求。
      // 未登录时后端会 401，所以先拦一次并说清下一步（比一个静默失败的按钮诚实）。
      onJoin={() => {
        if (!loggedIn) {
          setReceipt('关注分区要先登录。');
          return;
        }
        toggleFollow.mutate(!(boardFollow.data?.following ?? false));
      }}
      authorHref={appPath('u/' + encodeURIComponent(t.author.handle))}
      author={designAuthor}
      topic={designTopic}
      review={review}
      canEdit={canEdit}
      liked={t.viewer?.liked ?? false}
      bookmarked={t.viewer?.bookmarked ?? false}
      likeCount={t.like_count}
      onToggleLike={() => like.mutate(!(t.viewer?.liked ?? false))}
      onToggleBookmark={() => bookmark.mutate(!(t.viewer?.bookmarked ?? false))}
      onCopyLink={() => void copyLink(location.href, setReceipt)}
      onEdit={(next) => save.mutate(next)}
      onSubmitReport={(reason, detail, target) => {
        if (target) report.mutate({ target_type: 'post', target_id: target.id, reason, detail: detail || undefined });
        else report.mutate({ target_type: 'topic', target_id: t.id, reason, detail: detail || undefined });
      }}
      reported={reported}
      reportedIds={reportedIds}
      onDelete={() => remove.mutate()}
      deleting={remove.isPending}
      // **这两个端点后端都还没有**（forum/handler.go 里既没有 review 也没有 appeal；router.tsx 因此把申诉页整页隐藏）。
      // 但横幅上那句「改完可以重新提交」没有落点，正是这一轮要修的缺陷 —— 所以按钮留着、点了给一次诚实的回执：
      // 不静默、也不谎称已经提交。后端补上端点后，把这两行换成真请求即可。
      onAppeal={() => setReceipt('「申请人工复核」的端点后端还没有，所以这一次没有真的提交。')}
      onResubmit={() =>
        setReceipt('「重新提交审核」的端点后端还没有（PATCH /topics/{id} 不会重置 review_state），可以先点动作条上的「编辑」改内容。')
      }
      comments={comments}
      commentTotal={t.reply_count}
      // shortcut: 提及候选要 GET /users/mention-candidates 之类的端点（lib/api 里还没有），先不给候选
      candidates={[]}
      me={me}
      commentsFallback={
        posts.isPending ? (
          <Loading what='回复' className='py-8' />
        ) : posts.isError ? (
          <ErrorState what='回复' error={posts.error} onRetry={() => void posts.refetch()} />
        ) : undefined
      }
      onSubmitComment={(parentId, body) => reply.mutate({ parentId, body })}
      onDeleteComment={(_parentId, id) => removeReply.mutate(id)}
      onVoteComment={(id, value) => {
        const post = posts.data?.items.find((p) => p.id === id);
        // on = 已经在同向投过 -> 这次是取消（字段名是 my_vote，不是 viewer.value）
        vote.mutate({ id, value, on: post?.my_vote === value });
      }}
      replyPrompt={
        // 未登录**不隐藏评论区**（前端方案 §5.4：显示入口，点了引导登录，别让人不知道功能存在）
        canReply ? undefined : (
          <p className='flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-[13px] text-muted-foreground'>
            {loggedIn ? '你的账号还不能发帖回复（未激活或没有 topic.create 权限）。' : '登录后可以回复、点赞与收藏。'}
            <Button href={appPath('login?next=' + encodeURIComponent(routePath('t/' + t.id)))}>
              {loggedIn ? '查看账号状态' : '去登录'}
            </Button>
          </p>
        )
      }
      channels={authorChannels.data ?? []}
      // 打赏（L1）：收款码来自 GET /users/{handle}/channels（作者关掉展示开关时后端回空数组）。
      // 作者本人看不到打赏位（后端拒绝自己给自己打赏）；**没有登录的人**看得到码、看得到「去登录」
      // —— 扫码付款本来就不需要账号，只有「登记申报」才要。
      donateIsSelf={t.author.handle === me.handle}
      donateSettingsHref={appPath('settings#payment-channels')}
      onDonate={(v: { channelId: string; amountCents: number }) =>
        donate.mutate({ channelId: v.channelId, amountCents: v.amountCents })
      }
      donatePending={donate.isPending}
      donateError={donate.isError ? (isApiError(donate.error) ? donate.error.message : '登记失败，请重试') : null}
      donateDone={
        donate.isSuccess
          ? '已登记一笔 ¥' + formatCents(donate.data.amount_cents) + ' 的申报，等作者核对到账后会计入 TA 的主页。'
          : null
      }
      donateLoggedIn={loggedIn}
      donateLoginHref={appPath('login?next=' + encodeURIComponent(routePath('t/' + t.id)))}
      issueCount={wire.issue_open_count ?? 0}
      // 反馈页已经上线（/issues，router.tsx:59），所以四个入口是**真链接**而不是回执：
      //   kind 交给页面预设反馈类型，topic 限定列表范围与新建落点（issues.tsx:114-115）。
      //   「看全部反馈」不带 kind（那一页自己按页签选），所以只给它 topic。
      issueHrefFor={(kind) => appPath('issues?topic=' + encodeURIComponent(t.id) + '&kind=' + kind)}
      feedbackHref={appPath('issues?topic=' + encodeURIComponent(t.id))}
      sourcesLinked
      receipt={failed ? <ErrorState what={failed.what} error={failed.m.error} /> : receiptText ? <DesignActionNote message={receiptText} /> : null}
    />
  );
}

/** 主题详情 + 作者资料 → 设计件的 TopicAuthor。
 *  两处字段名都是**实测**的：论坛的 UserBriefDTO 回 avatar_hash（裸哈希），
 *  用户域 user.Profile 回的是平铺的 level/exp/exp_max/topic_count/like_received/joined_at/title。 */
export function toDesignAuthor(t: ApiTopicDetail, ap?: UserProfile): TopicAuthor {
  return {
    handle: t.author.handle,
    nickname: t.author.nickname,
    // 裸哈希没有 URL，统一走 mappers.imageUrl 拼 /img/<hash>；没有哈希就是空串（UserAvatar 自己回落首字母）
    avatar: imageUrl(t.author.avatar_hash) ?? '',
    // 角色徽标：详情会带 role（UserBriefDTO.Role，只有详情那条查询选这三列）。
    // 没带就是 null（列表项路径没有徽标位），不编一个默认角色出来。
    role: t.author.role ?? null,
    title: ap?.title ?? t.author.title ?? null,
    bio: ap?.bio ?? t.author.bio ?? '',
    level: ap?.level ?? t.author.level ?? 1,
    exp: ap?.exp ?? 0,
    exp_max: ap?.exp_max ?? 1,
    topic_count: ap?.topic_count ?? 0,
    like_received: ap?.like_received ?? 0,
    joined_at: ap?.joined_at ?? t.author.joined_at ?? '',
  };
}

/** 主题详情 → 设计件的 TopicDetail（时间在这一步变成展示串）。 */
export function toDesignTopic(t: ApiTopicDetail, author: TopicAuthor): TopicDetail {
  return {
    id: t.id,
    board: { slug: t.board.slug as BoardSlug, name: t.board.name },
    kind: t.kind,
    title: t.title,
    content_html: t.content_html,
    author,
    created_at: formatTime(t.created_at),
    updated_at: formatTime(t.updated_at),
    reply_count: t.reply_count,
    like_count: t.like_count,
    view_count: t.view_count,
    bookmark_count: 0,
    pinned: t.pinned,
    // 详情与列表项都叫 featured（TopicCardDTO.Featured 是 bool）
    featured: t.featured,
    locked: t.locked ?? false,
    sources: (t.sources ?? []).map(toDesignSource),
    images: t.images ?? [],
    viewer: { liked: t.viewer?.liked ?? false, bookmarked: t.viewer?.bookmarked ?? false, following: false },
  };
}

/** 审核态：review_state 只有 pending / approved / rejected 三个值（migrations 的 CHECK）。 */
export function toReview(t: ApiTopicDetail): TopicReview {
  const raw = t as ApiTopicDetail & TopicWire;
  return {
    state: (raw.review_state ?? 'approved') as TopicReview['state'],
    // L6：打回修改时那一份「最后过审版本」。**没有就不造假**（后端也只在第四态给）。
    revision: raw.revision_of ? { content_html: raw.revision_of.content_html, approved_at: raw.revision_of.approved_at } : null,
    // shortcut: 后端没有 review_pending_human 这个字段（forum/dto.go 里没有），先恒 false =「正在自动检查」那一档
    pendingHuman: false,
    note: raw.review_note ?? null,
  };
}

/** 后端回的是 /api/v1/...（不带 /dev 前缀），必须过 appPath 才能同时活在 / 与 /dev/ 两个前缀下。 */
export function toDesignSource(s: ApiSource): TopicSource {
  return {
    id: s.id,
    // 开放集合：词表在后端 sources.go 与 lib/api/forum 的 SOURCE_PROVIDERS，设计件按它挑图标
    provider: s.provider,
    label: s.label,
    go_path: appPath(s.go_path),
    extraction_code: s.extraction_code ?? null,
    size: s.size ?? '',
    verified_at: s.verified_at ? formatTime(s.verified_at) : '未核对',
    upkeep: s.upkeep === 'archived' ? 'archived' : 'active',
  };
}

/** GET /boards 的一行 → 设计件的 Board。
 *  member_count 与 joined **不在这里填**（BoardDTO 没有这两列：成员数就是关注数，
 *  它来自 GET /boards/{slug}/follow，由宿主只对当前这一个分区取一次再覆盖上去）——
 *  所以这里给的是「没有关注信息时」的中性值，不是假数。 */
export function toDesignBoard(b: ApiBoard): Board {
  return {
    slug: b.slug as BoardSlug,
    name: b.name,
    cover: b.cover ?? '',
    description: b.description,
    topic_count: b.topic_count,
    post_count: b.post_count ?? 0,
    member_count: b.member_count ?? 0,
    today_count: b.today_count ?? 0,
    // shortcut: hint 那句话后端没有（左栏悬停提示），要真话得后端给
    joined: false,
    hint: '',
  };
}

function boardHref(slug: BoardSlug): string {
  return appPath('b/' + encodeURIComponent(slug));
}

async function copyLink(href: string, setReceipt: (s: string) => void) {
  try {
    await navigator.clipboard.writeText(href);
    setReceipt('链接已复制：' + href);
  } catch {
    // 剪贴板没有权限（非 https / 用户拒绝）时给可复制的原文，仍然不是静默
    setReceipt('复制被浏览器挡下了，手动复制这个地址：' + href);
  }
}
