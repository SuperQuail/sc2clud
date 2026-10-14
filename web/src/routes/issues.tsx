import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import {
  createIssue,
  createIssueComment,
  fetchIssue,
  fetchIssueCommentReplies,
  fetchIssueComments,
  fetchIssues,
  fetchTopicIssues,
  setIssueCommentVote,
  updateIssue,
  type Issue,
  type IssueComment as ApiIssueComment,
} from '@/lib/api/issues';
import type { TopicAuthorSummary } from '@/lib/api/forum';
import { searchUsers, type SearchUser } from '@/lib/api/user';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { formatTime } from '@/lib/format';
import { useSession } from '@/lib/perms';
import { cn } from '@/lib/utils';
import type { CommentData } from '@/ui/comment/types';
import type { UserSummary } from '@/ui/user/user-badge';
import { IssueCard } from '@/devroom/pages/12-topic/_task/issue-card';
import { ISSUE_STATUS_LABEL, type IssueKind, type IssueStatus, type IssueSummary } from '@/devroom/pages/12-topic/_task/types';
import { IssueDetail } from '@/devroom/pages/13-issue/issue-detail';
import { IssueFilterBar, type Scope, type SortKey } from '@/devroom/pages/13-issue/issue-filter-bar';
import { NewIssueDialog } from '@/devroom/pages/13-issue/new-issue-dialog';
import { matchesQuery, parseQuery } from '@/devroom/pages/13-issue/query';
import { IssueKindButton, KINDS, TopicTaskTabs } from '@/devroom/pages/13-issue/shared';
import type { IssueDetail as DesignIssueDetail } from '@/devroom/pages/13-issue/types';
import { imageUrl } from './_parts/mappers';
import { Empty, ErrorState, Loading } from './_parts/state';

// 问题反馈页：DevRoom 13-issue 的**同一个版面**，数据换成真端点（完全重构/进行中/设计对齐.md 第 2 节「问题反馈」一行）。
// 版面一格都不是这一页画的：顶部双按钮 / 四个类型入口 / 检索条 / 列表项 / 详情面板 / 新建弹窗全部来自
// @/devroom/pages/13-issue 与 12-topic/_task（它们已是 prop 驱动的共享件）。这一页只做三件事：
//   ① 取数据（列表 / 详情 / 评论 / 楼中楼）；
//   ② 把后端 DTO 的形状对成设计件吃的形状（**字段名照 forum/internal/forum/dto.go 抄**，见下面 toSummary / toDesignDetail）；
//   ③ 把每个动作接到真端点上（新建、开关、发评论）。
//
// 端点（forum/internal/forum/handler.go:48-82）：GET /issues、GET /topics/{id}/issues、GET /issues/{id}、
// GET /issues/{id}/comments、GET /issue-comments/{id}/replies、POST /topics/{id}/issues、PATCH /issues/{id}、
// POST /issues/{id}/comments。
//
// 入口参数：?topic=<资源帖 public id>（限定范围 + 新建的落点）、?kind=bug|feature|difficulty|other
// （从帖子页四个入口点进来时直接开对应类型的反馈面板，13-issue/index.tsx:56-61 的语义）。

/** 排序文案：**不抄 DevRoom 的 SORT_LABEL** —— 那张稿的 created 是升序（label「最早创建」，index.tsx:105），
 *  而后端三种排序列全是 DESC（pgsql/issues.go:110-113、157 行 ORDER BY … DESC）。照抄就是一句假话。 */
const SORT_TEXT: Record<SortKey, string> = { updated: '最新更新', created: '最新创建', old: '最早创建', comments: '评论最多' };

/** D5：顶上两个页签（帖子内容 / 问题反馈）的选中态写在地址上。
 *  写出来的唯一一处是 routes/topic.tsx 的 `onOpenIssue`（`issues?topic=<id>`，缺这个参数 = 反馈页）。 */
const VIEW_PARAM = 'view';

function parseKind(v: string | null): IssueKind | undefined {
  return v === 'bug' || v === 'feature' || v === 'difficulty' || v === 'other' ? v : undefined;
}

/** UserBriefDTO（forum/dto.go:12-17）→ 用户件的 UserSummary。
 *  头像字段是**裸哈希** avatar_hash，不过 imageUrl 换算的话头像全是首字母占位（与 mappers.ts 同一个坑）。 */
function toUser(u: TopicAuthorSummary): UserSummary {
  // avatar_hash 现在就在 TopicAuthorSummary 上（照 DTO 抄），不用再 as 一层
  return { handle: u.handle, nickname: u.nickname, avatar: imageUrl(u.avatar_hash), role: u.role ?? null, title: u.title ?? null };
}

/** IssueDTO → W1 的 IssueSummary。**两处必换算**（设计稿的便利命名 vs 后端契约）：
 *  id ← number（卡片与详情显示的 #编号；public_id 只用来发请求），标签在详情件里叫 labels 而后端叫 tags。 */
function toSummary(i: Issue): IssueSummary {
  return {
    id: i.number,
    kind: i.kind,
    status: i.status,
    title: i.title,
    author: toUser(i.author),
    commentCount: i.comment_count,
    createdAt: formatTime(i.created_at),
    updatedAt: formatTime(i.updated_at),
  };
}

/** IssueDTO / IssueDetailDTO → 13-issue 详情面板吃的形状（bodyMarkdown 它不渲染，正文走 bodyHtml）。 */
function toDesignDetail(i: Issue, bodyHtml: string): DesignIssueDetail {
  return {
    ...toSummary(i),
    bodyMarkdown: '',
    bodyHtml,
    labels: i.tags,
    assignee: i.assignee ? toUser(i.assignee) : null,
  };
}

/** 提及候选：后端 `SearchItem` → 编辑器吃的 `MentionCandidate`（与 routes/topic.tsx 同一份映射：
 *  id 后端就是数字 user id，正是 `mention:<id>` 里那个真源；avatar 已拼成 /img/<hash>；
 *  ambiguous（按显示名判的重名）就是编辑器要的 duplicate 标记）。 */
export function toMentionCandidates(items: SearchUser[]): MentionCandidate[] {
  return items.map((u) => ({
    id: String(u.id),
    handle: u.handle,
    nickname: u.nickname,
    avatar: u.avatar,
    duplicate: u.ambiguous,
  }));
}

/** IssueCommentDTO → @/ui/comment 的 CommentData（与 routes/_parts/mappers.ts 的 toComments 同一套映射）。 */
function toComment(c: ApiIssueComment, replies: ApiIssueComment[]): CommentData {
  const one = (x: ApiIssueComment): CommentData => ({
    id: x.id,
    author: toUser(x.author),
    body: x.body_html,
    createdAt: formatTime(x.created_at),
    likes: x.like_count,
    // J3（拍板）：踩数**按身份下发** —— 普通用户 / 游客的响应里没有这个键（DTO 带 omitempty），
    // 所以这里**故意不回落成 0**：`?? 0` 会把「接口没给」变成「0 个踩」，等于前端替后端把这个数补出来。
    // CommentData.dislikes 已是可选：undefined 传到 CommentActions 就是**那一格不显示数字**，
    // 「我自己点没点」由下面的 disliked（my_vote）回答。
    dislikes: x.dislike_count,
    // 真源是 my_vote（dto.go:198），不是 viewer.value —— 读错字段时赞踩态恒为假且不报错
    liked: x.my_vote === 1,
    disliked: x.my_vote === -1,
  });
  const base = one(c);
  return replies.length === 0 ? base : { ...base, replies: { total: replies.length, items: replies.map(one) } };
}

export function IssuesPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const session = useSession();
  const queryClient = useQueryClient();

  const topicId = sp.get('topic') ?? '';
  const entryKind = parseKind(sp.get('kind'));

  const [pickedKind, setPickedKind] = useState<IssueKind | null>(null);
  const [statusTab, setStatusTab] = useState<IssueStatus>('open');
  const [status, setStatus] = useState<IssueStatus | undefined>(undefined);
  const [kind, setKind] = useState<IssueKind | undefined>(undefined);
  // 排序也从 URL 起步（`?sort=`）：与检索词的 `?q=` 同一条规矩 —— 分享出去的地址要能还原同一屏。
  // 值域与后端 `parseIssueSort` 一致（updated / created / old / comments，见 lib/api/issues.ts）。
  const [sort, setSort] = useState<SortKey>(() => {
    const raw = sp.get('sort');
    return raw === 'created' || raw === 'old' || raw === 'comments' ? raw : 'updated';
  });
  const [scope, setScope] = useState<Scope>('all');
  // 检索词从 URL 起步（`?q=`）：这样「搜到了把地址发给人」能还原出同一屏结果。
  // 之后是新输入的本地状态 —— **不往回写 URL**（每敲一个字都改地址会堆满历史，
  // 而搜索是高频动作）。够用的那一半：深链进来能还原，敲字不受地址栏打扰。
  const [query, setQuery] = useState(() => sp.get('q') ?? '');
  const [pickedLabels, setPickedLabels] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  // @ 提及候选（拍板 08 §第三轮 4）：与帖子页同一条端点（GET /search?type=users），
  // 同一个规矩 —— **敲 @ 才去取**（后端对空词回 400，而且每次进页面都发是白花钱）。
  // 反馈评论的编辑器就是 @/ui/comment 的 ReplyBox（MarkdownEditor），所以候选从这里喂进去。
  const [mentionQuery, setMentionQuery] = useState('');
  const mentions = useQuery({
    queryKey: qk.search('users', mentionQuery),
    queryFn: ({ signal }) => searchUsers(mentionQuery, 20, signal),
    enabled: mentionQuery !== '',
    staleTime: 30_000,
  });

  const parsed = useMemo(() => parseQuery(query), [query]);
  const meHandle = session.session?.handle ?? '';
  // 范围是**服务端**筛选（author= / assignee=me，forum/handler.go:579-586），两个都要登录才拿得到「我」。
  // 未登录时不发这次请求：宁可给一句「先登录」，也不要发一条 author='' 的查询把全站反馈当成「我创建的」。
  const scopeReady = scope === 'all' || meHandle !== '';
  const wantStatus: IssueStatus = status ?? parsed.status ?? statusTab;
  const wantKind = kind ?? parsed.kind;
  // J5：自由词**发给后端搜**（`?q=`，标题 + 正文字面匹配）。
  // 为什么不留在前端过滤：前端只有当前这一页 —— 正文里的词、以及还没翻到的页，一律搜不到，
  // 而「搜了没结果」与「真的没有」在界面上长得一模一样（这正是交接单 §5.2 那种缺陷形态）。
  // 限定词（is:/kind:/author:）仍先在前端解析：它们映射到服务端的强类型参数，不是塞进 q 里。
  const wantQ = parsed.text;
  const listKey = ['issues', { topic: topicId, status: wantStatus, kind: wantKind ?? '', author: scope === 'mine' ? meHandle : '', assignee: scope === 'assigned' ? 'me' : '', sort, q: wantQ }] as const;

  const list = useInfiniteQuery({
    queryKey: listKey,
    enabled: scopeReady,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const f = {
        status: wantStatus,
        kind: wantKind,
        author: scope === 'mine' ? meHandle : undefined,
        assignee: scope === 'assigned' ? ('me' as const) : undefined,
        sort,
        q: wantQ === '' ? undefined : wantQ,
        cursor: pageParam,
      };
      return topicId ? fetchTopicIssues(topicId, f, signal) : fetchIssues(f, signal);
    },
    // sort=comments 没有游标：带 cursor 的后端直接 400（issues.go:31 ErrSortUnpageable），所以不给下一页
    getNextPageParam: (last) => (sort === 'comments' ? null : last.next),
    staleTime: 30_000,
  });

  const detail = useQuery({
    queryKey: ['issue', selectedId],
    queryFn: ({ signal }) => fetchIssue(selectedId ?? '', signal),
    enabled: selectedId !== null,
    staleTime: 30_000,
  });

  const thread = useQuery({
    queryKey: ['issue', selectedId, 'comments'],
    enabled: selectedId !== null,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const page = await fetchIssueComments(selectedId ?? '', {}, signal);
      // shortcut: 楼中楼没有批量端点，IssueCommentDTO 也没有 reply_count（dto.go:191-201），
      //   「哪条有回复」只能逐条问 —— 一页 20 条 = 21 个请求。后端补批量或计数后改这里。
      const replies = await Promise.all(page.items.map((c) => fetchIssueCommentReplies(c.id, signal)));
      return page.items.map((c, i) => toComment(c, replies[i] ?? []));
    },
  });

  const create = useMutation({
    mutationFn: (draft: { kind: IssueKind; title: string; bodyJson: string }) =>
      createIssue(topicId, { kind: draft.kind, title: draft.title, body_md: draft.bodyJson }),
    onSuccess: (issue) => {
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      closeDialog();
      resetFilters();
      setStatusTab('open');
      setSelectedId(issue.id);
      setReceipt('已提交 #' + issue.number + '「' + issue.title + '」，它就在列表最上面。');
    },
  });

  const toggle = useMutation({
    mutationFn: (next: IssueStatus) => updateIssue(selectedId ?? '', { status: next }),
    // 幂等开关：等服务端回话再刷新（前端方案 §5.3 允许乐观更新，这里不做是因为旁边还有详情与列表两份数据）
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      void queryClient.invalidateQueries({ queryKey: ['issue', selectedId] });
    },
  });

  const comment = useMutation({
    mutationFn: (v: { parentId: string | null; body: string }) =>
      createIssueComment(selectedId ?? '', { body_md: v.body, parent_id: v.parentId ?? undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['issue', selectedId, 'comments'] });
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      void queryClient.invalidateQueries({ queryKey: ['issue', selectedId] });
    },
  });

  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.items), [list.data]);
  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          pickedLabels.every((l) => row.tags.includes(l)) &&
          // 服务端已经筛过 status / kind / 自由词（`?q=`），这里只做**它筛不了的那些**：
          // label（本项目还没有标签表）与 #编号。所以 `text` 要从前端这一层去掉 ——
          // 留着它等于「服务端搜一遍、前端又搜一遍」，而前端这一遍只看得到当前页
          // （结果是服务端明明命中了、却被前端滤掉）。
          matchesQuery(
            { ...parsed, status: undefined, kind: undefined, text: '' },
            {
              title: row.title,
              body: '',
              status: row.status,
              kind: row.kind,
              labels: row.tags,
              authorNickname: row.author.nickname,
              authorHandle: row.author.handle,
              number: row.number,
            },
          ),
      ),
    [rows, parsed, pickedLabels],
  );

  // 评论的赞 / 踩：同向再点一次 = 取消（value=0 → DELETE）。怎么知道「同向」：CommentData 上的 liked/disliked
  // 是 toComment() 从 my_vote 换算的（dto.go:198），与帖子页 onVoteComment 用同一个判定。
  const voteComment = useMutation({
    mutationFn: (v: { id: string; value: 1 | -1 }) => {
      const mine = (thread.data ?? [])
        .flatMap((c) => [c, ...(c.replies?.items ?? [])])
        .find((c) => c.id === v.id);
      const same = v.value === 1 ? mine?.liked === true : mine?.disliked === true;
      return setIssueCommentVote(v.id, same ? 0 : v.value);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['issue', selectedId, 'comments'] }),
  });

  const labelOptions = useMemo(() => [...new Set(rows.flatMap((r) => r.tags))], [rows]);
  const topicTitle = rows[0]?.topic_title ?? '';
  const hasNext = sort !== 'comments' && list.hasNextPage;
  const dialogKind = pickedKind ?? entryKind;
  const failed =
    ([
      { what: '提交反馈', m: create },
      { what: '改状态', m: toggle },
      { what: '发评论', m: comment },
      { what: '评论投票', m: voteComment },
    ].find((s) => s.m.isError) ?? null);

  function closeDialog() {
    setPickedKind(null);
    if (entryKind) {
      const next = new URLSearchParams(sp);
      next.delete('kind');
      setSp(next, { replace: true });
    }
  }

  function resetFilters() {
    setQuery('');
    setStatus(undefined);
    setKind(undefined);
    setScope('all');
    setPickedLabels([]);
  }

  /** 四个入口：未登录先引导登录，没有 topic 就说清反馈要挂在哪（不静默、也不假装能提交）。 */
  function openKind(k: IssueKind) {
    if (!session.isLoggedIn) {
      setReceipt('提反馈要先登录。');
      return;
    }
    if (!topicId) {
      setReceipt('反馈必须挂在某张资源帖下面（后端 forum.not_resource）：从帖子页的「问题反馈」入口点进来，链接里就会带上 ?topic=<帖子 id>。');
      return;
    }
    setReceipt(null);
    setPickedKind(k);
  }

  const me = { nickname: session.session?.nickname ?? '', avatar: session.session?.avatar ?? null };
  const loginHref = appPath('login?next=' + encodeURIComponent(routePath('issues') + (topicId ? '?topic=' + encodeURIComponent(topicId) : '')));

  return (
    <div className='flex w-full flex-col gap-4'>
      <div className='w-full'>
        <TopicTaskTabs
          // D5：页签的选中态**由 URL 决定**（?view=issue）—— 两页共用这一套 key，
          // 「帖子内容」= /t/<id>、「问题反馈」= /issues?topic=<id>&view=issue，于是两处看同一页必然一致，
          // 而不会出现「地址在反馈页、按钮还高亮着帖子内容」那种两套真源的分叉。
          value={sp.get(VIEW_PARAM) === 'content' ? 'content' : 'issue'}
          onChange={(v) => {
            if (v !== 'content') return;
            // 「帖子内容」这一格要回帖子页；全站列表（没有 ?topic=）不属于任何帖子，点了给一句实话
            if (topicId) void navigate(routePath('t/' + topicId));
            else setReceipt('当前是全站反馈列表（没有 ?topic=），没有对应的帖子内容可回；从帖子页的「问题反馈」入口进来才有。');
          }}
          onOpenIssue={() => {
            // 重复点这一格 = 「回到全部反馈列表」：清筛选 + 收掉入参 kind（把地址也擦干净）
            setScope('all');
            setReceipt(null);
            if (sp.get('kind') || sp.get(VIEW_PARAM) !== 'issue') {
              const next = new URLSearchParams(sp);
              next.delete('kind');
              next.set(VIEW_PARAM, 'issue');
              setSp(next, { replace: true });
            }
          }}
        />

        <div className='mt-4 grid grid-cols-4 gap-2 rounded-lg border border-dashed border-border p-3' aria-label='我要反馈'>
          {KINDS.map((k) => (
            <span key={k} className='flex [&>*]:flex-1'>
              <IssueKindButton kind={k} size='lg' onSelect={openKind} />
            </span>
          ))}
        </div>

        <div className='mt-4'>
          <IssueFilterBar
            query={query}
            onQuery={setQuery}
            status={status}
            onStatus={setStatus}
            kind={kind}
            onKind={setKind}
            sort={sort}
            onSort={setSort}
            scope={scope}
            onScope={setScope}
            labels={labelOptions}
            pickedLabels={pickedLabels}
            onToggleLabel={(l) => setPickedLabels((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]))}
            onReset={resetFilters}
          />
        </div>

        {query !== '' ? (
          <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
            自由词（<code>?q=</code>）与 <code>is:</code> / <code>kind:</code> / <code>author:</code> 都是**服务端筛选** ——
            自由词匹配标题与正文（后端字面匹配，中文两字词也命中），所以**还没翻到的页也搜得到**。
            只有 <code>label:</code> 与 <code>#编号</code> 还在本页 {rows.length} 条里筛（本项目还没有标签表）。
          </p>
        ) : null}

        {failed ? (
          <div className='mt-3'>
            <ErrorState what={failed.what} error={failed.m.error} />
          </div>
        ) : receipt ? (
          <p role='status' className='mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-[12px] text-foreground'>
            {receipt}
            {!session.isLoggedIn ? <Button href={loginHref}>去登录</Button> : null}
            <Button ghost className='ml-auto' onClick={() => setReceipt(null)}>
              知道了
            </Button>
          </p>
        ) : null}

        <div className='mt-4 grid items-start gap-4 md:grid-cols-[minmax(340px,384px)_minmax(0,1fr)]'>
          <section className='flex min-w-0 flex-col rounded-lg border border-border bg-card' aria-label='反馈列表'>
            <div className='border-b border-border p-3'>
              <Tabs selected={statusTab} onSelect={(id: string) => setStatusTab(id === 'closed' ? 'closed' : 'open')}>
                <Tab id='open' title={ISSUE_STATUS_LABEL.open} />
                <Tab id='closed' title={ISSUE_STATUS_LABEL.closed} />
              </Tabs>
              <p className='mt-2 text-[11px] text-muted-foreground tabular-nums'>
                {topicTitle ? '《' + topicTitle + '》下 ' : ''}本页 {visible.length} 条 · 按 {SORT_TEXT[sort]} 排序 ·「
                {ISSUE_STATUS_LABEL[wantStatus]}」
                {hasNext ? ' · 还有更多没加载' : ''}
                {/* 页签上不写计数：三种筛选都在服务端，数出来的只会是「这一页的」，比没有更容易误读 */}
              </p>
            </div>

            {!scopeReady ? (
              <Empty
                title='按「我创建的 / 指派给我」筛要先登录'
                hint='这两个范围是服务端筛选（author= / assignee=me），游客没有「我」。'
                action={<Button href={loginHref}>去登录</Button>}
              />
            ) : list.isPending ? (
              <Loading what='反馈' className='py-10' />
            ) : list.isError ? (
              <ErrorState what='反馈列表' error={list.error} onRetry={() => void list.refetch()} />
            ) : visible.length === 0 ? (
              <Empty
                title='没有符合条件的反馈'
                hint='换个关键词，或清掉上面的筛选；也可能是这一分类下暂时没有。'
                action={
                  <span className='flex flex-wrap items-center justify-center gap-2'>
                    <Button onClick={resetFilters}>清空筛选</Button>
                    <Button primary onClick={() => openKind(parsed.kind ?? 'bug')}>
                      新建一条
                    </Button>
                  </span>
                }
              />
            ) : (
              <>
                <ul className='flex flex-col'>
                  {visible.map((row) => (
                    <li key={row.id}>
                      <ClickableIssueRow issue={toSummary(row)} selected={row.id === selectedId} onOpen={() => setSelectedId(row.id)} />
                    </li>
                  ))}
                </ul>
                {hasNext ? (
                  <div className='border-t border-border p-3'>
                    <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                      {list.isFetchingNextPage ? '加载中…' : '加载更多'}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </section>

          <section className='min-w-0 rounded-lg border border-border bg-card p-4'>
            {selectedId === null ? (
              <div className='flex flex-col items-center gap-2 px-6 py-20 text-center'>
                <p className='text-sm font-medium text-foreground'>从左边选一条反馈看详情</p>
                <p className='max-w-[46ch] text-[12px] leading-relaxed text-muted-foreground'>
                  详情里有正文、状态开关（Open / Closed）、以及复用 @/ui/comment 的评论区——评论、楼中楼、赞踩都在那里。
                </p>
              </div>
            ) : detail.isPending ? (
              <Loading what='反馈详情' className='py-16' />
            ) : detail.isError ? (
              <ErrorState what='反馈详情' error={detail.error} onRetry={() => void detail.refetch()} />
            ) : detail.data ? (
              // 详情面板**只吃详情响应**：换页签把这条挤出列表时它照样在（列表那边只是筛选结果）
              <IssueDetail
                issue={toDesignDetail(detail.data, detail.data.body_html)}
                comments={thread.data ?? []}
                me={me}
                candidates={toMentionCandidates(mentions.data ?? [])}
                onMentionQuery={setMentionQuery}
                onSetStatus={(next) => toggle.mutate(next)}
                onComment={(parentId, body) => comment.mutate({ parentId, body: body.json })}
                // on = 已经在同向投过 -> 这一次是取消（CommentList 的约定与帖子页一致）
                onVote={(id, value) => voteComment.mutate({ id, value })}
                onClose={() => setSelectedId(null)}
              />
            ) : null}
            {thread.isError ? (
              <div className='mt-3'>
                <ErrorState what='评论区' error={thread.error} onRetry={() => void thread.refetch()} />
              </div>
            ) : null}
          </section>
        </div>
      </div>

      {dialogKind ? (
        <NewIssueDialog
          initialKind={dialogKind}
          onClose={closeDialog}
          onSubmit={(draft) => create.mutate({ kind: draft.kind, title: draft.title, bodyJson: draft.bodyJson })}
        />
      ) : null}
    </div>
  );
}

/**
 * 列表行的**点击容器**：W1 的 IssueCard 是纯展示件（它自己写了这一句：点击行为由列表容器决定），
 * 所以这里只负责「能点 + 能只用键盘进详情」，行本身仍然是那一份共享件。
 * **为什么这里有一份**：13-issue/index.tsx 里的同款是文件内私有函数（没 export），产品页拿不到它；
 * 行为与那份逐条一致（role=button / Enter+Space / aria-current / aria-label）。
 */
function ClickableIssueRow({ issue, selected, onOpen }: { issue: IssueSummary; selected: boolean; onOpen: () => void }) {
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
        'cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected && 'bg-muted/60',
      )}
    >
      <IssueCard issue={issue} />
    </div>
  );
}
