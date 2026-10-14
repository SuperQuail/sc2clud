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
import { fetchUserProfile, type UserProfile } from '@/lib/api/user';
import { formatTime } from '@/lib/format';
import { DesignActionNote } from '@/devroom/pages/12-topic/design-action';
import { TopicView, type TopicReview } from '@/devroom/pages/12-topic/topic-view';
import type {
  Board,
  BoardNav,
  BoardSlug,
  PaymentChannel,
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

/** 后端详情里 lib/api/forum.ts 的 TopicDetail **还没声明**的字段（照 forum/internal/forum/dto.go 抄）。
 *  那一层是别人的在途写作用域，所以这里只声明本页真正用到的几个，改完就删（与 mappers 的 TopicCardRaw 同款处理）。 */
type TopicWire = {
  review_state?: string;
  review_note?: string | null;
  issue_open_count?: number;
  can_edit?: boolean;
  can_reply?: boolean;
  /** 头像：后端 forum 的 UserBriefDTO 回的是**裸哈希** avatar_hash，前端类型里却写的 avatar */
  author: { avatar_hash?: string | null };
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

  const authorHandle = topic.data?.author.handle ?? '';
  const boardSlug = topic.data?.board.slug ?? '';
  // 作者卡片的等级 / 经验 / 头衔只有 /users/{handle} 有（主题详情的 author 只有 handle/nickname/bio/level/joined_at）
  const authorProfile = useQuery({
    queryKey: qk.profile(authorHandle),
    queryFn: ({ signal }) => fetchUserProfile(authorHandle, signal),
    enabled: authorHandle !== '',
    staleTime: 60_000,
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
  const save = useMutation({
    mutationFn: (next: { title: string; text: string }) =>
      updateTopic(topicId, { title: next.title, content_md: next.text }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.topic(topicId) });
      void queryClient.invalidateQueries({ queryKey: qk.posts(topicId) });
      setReceipt('已保存 · 标题与正文都更新了。');
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
  // 分区列表没回来也要能画这一页：用主题自带的两字段兜一个最小 Board，统计先空着（不假装有数）
  const designBoard: Board = current ?? {
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
  const designAuthor = toDesignAuthor(t, ap);
  // shortcut: GET /users/{handle}/channels 存在（reward 域），但 lib/api 还没有它的函数 —— 没接就恒空，
  //   赞助面板照常渲染（展开后是「作者还没开启收款码」那句话，不是一块假装有码的区域）。
  const channels: PaymentChannel[] = [];
  const review = toReview(t);

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
      // shortcut: 「关注分区」后端没有端点，点一次给回执，不假装已关注
      onJoin={() => setReceipt('「关注分区」后端还没有端点，所以这一次没有真的关注。')}
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
        vote.mutate({ id, value, on: post?.viewer?.value === value });
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
      channels={channels}
      issueCount={wire.issue_open_count ?? 0}
      // shortcut: 反馈页（13-issue）前端还没有那一页，所以不给 href（给了就是 404）、改成点一次给回执。
      //   后端两个端点都在：GET /issues 与 GET /topics/{id}/issues?status=open。
      onOpenFeedback={(kind) =>
        setReceipt('反馈页还没有上线' + (kind ? '（已按「' + kind + '」预设类型）' : '') + '；后端接口已经在了，这一页还没做。')
      }
      onOpenIssue={() => setReceipt('反馈页还没有上线；后端接口已经在了（GET /topics/{id}/issues），这一页还没做。')}
      sourcesLinked
      receipt={failed ? <ErrorState what={failed.what} error={failed.m.error} /> : receipt ? <DesignActionNote message={receipt} /> : null}
    />
  );
}

/** 主题详情 + 作者资料 → 设计件的 TopicAuthor。
 *  两处字段名都是**实测**的：论坛的 UserBriefDTO 回 avatar_hash（裸哈希），
 *  用户域 user.Profile 回的是平铺的 level/exp/exp_max/topic_count/like_received/joined_at/title。 */
export function toDesignAuthor(t: ApiTopicDetail, ap?: UserProfile): TopicAuthor {
  const raw = t as ApiTopicDetail & TopicWire;
  return {
    handle: t.author.handle,
    nickname: t.author.nickname,
    // 裸哈希没有 URL，统一走 mappers.imageUrl 拼 /img/<hash>
    avatar: imageUrl(raw.author.avatar_hash) ?? t.author.avatar ?? '',
    // shortcut: 主题详情不回角色；要显示角色徽标得让 forum 的 UserBriefDTO 带上 role
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
    // 详情响应用 featured（列表项才叫 featured_at）——两个都认，别把精华标记丢了
    featured: t.featured ?? t.featured_at != null,
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

export function toDesignBoard(b: ApiBoard): Board {
  return {
    slug: b.slug as BoardSlug,
    name: b.name,
    cover: b.cover ?? '',
    description: b.description,
    topic_count: b.topic_count,
    post_count: b.post_count ?? 0,
    // shortcut: 后端 BoardDTO（forum/dto.go）没有 member_count —— 成员数这一格只能是 0，要真数得给后端加统计
    member_count: b.member_count ?? 0,
    today_count: b.today_count ?? 0,
    // shortcut: 「关注分区」后端没有端点；hint 那句话后端也没有
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
