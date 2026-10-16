import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { TopicPage } from './topic';
// 映射函数 2026-10-14 搬到 _parts/topic-mappers（宿主只留取数与传参，见那边的注释）
import { toMentionCandidates } from './_parts/topic-mappers';

// **真站这一页**的接线断言（房间那一屏由 12-topic 自己的测试盯）：
//   ① 实测的线格式喂进来，整页要画得出来（不是白屏 / 不是崩）；
//   ② 每条动作打到的端点与请求体字段名都对（board / parent_id / target_type / content_md 这些都栽过）；
//   ③ can_reply=false 时输入框换成引导登录那一块（前端方案 §5.4：未登录也要能看见评论区）。
// 后端不在本地，所以这里 mock 的是 lib/api —— 网络层以下的都真的跑。

const WIRE = {
  id: '01a13540-ff54-7f07-a975-51e08a5f831c',
  kind: 'resource',
  title: '第三章「余烬」平衡性改动说明',
  excerpt: '摘要',
  board: { slug: 'custom-campaign', name: '自制战役' },
  // role 是**详情**才下发的那一列（UserBriefDTO.Role，拍板 08 §第三轮 3）——
  // 右栏作者卡上的徽标就靠它，列表项上没有这个键。
  author: {
    handle: 'Alenger',
    nickname: '爱兰琪尔',
    avatar_hash: 'a1b2c3',
    avatar_small_hash: 'd4e5f6',
    role: { key: 'creator', name: '认证创作者', badge_color: '#2563eb' },
  },
  content_md: '正文',
  content_html: '<p>正文第一段。</p>',
  created_at: '2026-10-08T06:35:53Z',
  updated_at: '2026-10-13T12:25:08Z',
  reply_count: 1,
  like_count: 1,
  view_count: 6,
  issue_open_count: 7,
  review_state: 'rejected',
  review_note: '正文含未标明来源的下载地址',
  can_edit: true,
  can_reply: false,
  featured: true,
  pinned: true,
  locked: false,
  viewer: { liked: false, bookmarked: true },
  sources: [
    {
      id: 's1',
      provider: 'pan123',
      label: '第三章整合包',
      go_path: '/api/v1/topics/01a13540/sources/s1/go',
      url: 'https://example.invalid/x',
      extraction_code: 'c2c',
      size: '2.4 GB',
      upkeep: 'active',
      verified_at: '2026-10-12T01:20:00Z',
    },
  ],
};
const PROFILE = {
  id: 'u1',
  handle: 'Alenger',
  nickname: '爱兰琪尔',
  avatar: '/img/a1b2c3',
  avatar_small: '',
  bio: '战役作者',
  status: 'active',
  level: 27,
  exp: 640,
  exp_max: 1000,
  topic_count: 86,
  like_received: 12480,
  joined_at: '2024-03-01T00:00:00Z',
  title: { name: '执政官', color: '#2563eb' },
};
const BOARD = {
  slug: 'custom-campaign',
  name: '自制战役',
  description: '玩家自制战役与地图',
  cover: null,
  topic_count: 12,
  post_count: 30,
  today_count: 1,
};

// **上行正文**（缺陷清单 D6 的同一条根因）：编辑器给宿主的是 EditorState JSON，而后端 content_md 收的是
// **Markdown**（forum 的 render 过 goldmark → bluemonday 渲染成 content_html）。把 JSON 当 Markdown 发上去，
// 库里存的就是那串 JSON，别人打开看到的就是它。
//
// 这一份把编辑器换成假的：Lexical 在 jsdom 里收不到真实输入（实测 fireEvent.input 不产生 onChange），
// 测它等于测库。假件照真编辑器的契约报数：onChange 的两份是 **EditorState JSON + HTML**，
// 且**初值非空时装载完报一次**（真编辑器由 OnChangePlugin 报 —— 编辑弹层的「正文不能为空」就靠那一下）。
const EDITOR_JSON = JSON.stringify({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: '走到第二波就卡关。', type: 'text', version: 1 }],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
});
vi.mock('@/ui/rich/markdown-editor', async () => {
  const [{ default: Input }, { useEffect, useRef, useState }] = await Promise.all([
    import('@jetbrains/ring-ui-built/components/input/input'),
    import('react'),
  ]);
  return {
    MarkdownEditor: ({ value, onChange }: { value: string; onChange: (json: string, html: string) => void }) => {
      const done = useRef(false);
      const [typed, setTyped] = useState('');
      useEffect(() => {
        if (done.current || value === '') return;
        done.current = true;
        onChange(value, '<p>已装载</p>');
      }, [value, onChange]);
      return (
        <Input
          label='假编辑器（测试注入）'
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            onChange(e.target.value, '<p>不管</p>');
          }}
        />
      );
    },
  };
});

// vi.mock 的工厂会被提升到文件顶部，所以假函数要用 vi.hoisted 一起提上去
const mocks = vi.hoisted(() => ({
  createReport: vi.fn(),
  deleteTopic: vi.fn(),
  deletePost: vi.fn(),
  createPost: vi.fn(),
  updateTopic: vi.fn(),
  /** 详情响应的覆盖（默认 null = 用 WIRE）。B6 那条要靠它演「保存后服务端把 review_state 打回 pending」。 */
  topic: { current: null as Record<string, unknown> | null },
  /** 回复列表响应的覆盖（默认 null = 空列表）。J3 那条要喂一条「后端没下发 dislike_count」的评论。 */
  posts: { current: null as Record<string, unknown> | null },
  followBoard: vi.fn(),
  unfollowBoard: vi.fn(),
  /** 作者关注（D19）：user 侧那三条 —— 前端此前一直没接，产品页上根本没有这颗按钮 */
  followUser: vi.fn(() => Promise.resolve({ target: 'user', handle: 'someone-else', following: true, follower_count: 1 })),
  unfollowUser: vi.fn(() => Promise.resolve({ target: 'user', handle: 'someone-else', following: false, follower_count: 0 })),
  userFollowState: { current: { target: 'user', handle: 'someone-else', following: false, follower_count: 0 } as Record<string, unknown> },
  /** GET /boards/{slug}/follow 的回执（follow.State 逐字形状） */
  followState: { current: { target: 'board', slug: 'custom-campaign', following: false, follower_count: 0 } as Record<string, unknown> },
  /** @ 提及候选（GET /search?type=users）：空数组 = 没敲 @ 时不取，敲了才有 */
  searchUsers: vi.fn(() => Promise.resolve([])),
  /** D73：can() 假实现的开关——默认全有（版主视角），非版主用例临时关掉 */
  canImpl: { current: true },
}));

vi.mock('@/lib/api/forum', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/forum')>();
  return {
    ...actual,
    fetchTopic: () => Promise.resolve({ ...WIRE, ...(mocks.topic.current ?? {}) }),
    fetchPosts: () => Promise.resolve(mocks.posts.current ?? { items: [], next: null }),
    fetchBoards: () => Promise.resolve([BOARD]),
    createReport: mocks.createReport,
    deleteTopic: mocks.deleteTopic,
    deletePost: mocks.deletePost,
    createPost: mocks.createPost,
    updateTopic: mocks.updateTopic,
    setTopicLike: () => Promise.resolve(),
    setTopicBookmark: () => Promise.resolve(),
    setPostVote: () => Promise.resolve(),
  };
});
vi.mock('@/lib/api/user', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/user')>();
  return { ...actual, fetchUserProfile: () => Promise.resolve(PROFILE), searchUsers: mocks.searchUsers };
});
// 关注状态（L5 / 任务 1+2）：这一页那格「成员」与那颗「关注分区」按钮的真源就是这三条。
// 默认 follower_count=0 / following=false 是**故意的**：下面那条用例把它设成 128，
// 于是「恒 0」的旧行为一定会红 —— 而不是「两个 0 恰好相等」。
vi.mock('@/lib/api/follow', () => ({
  fetchBoardFollow: () => Promise.resolve(mocks.followState.current),
  followBoard: mocks.followBoard,
  unfollowBoard: mocks.unfollowBoard,
  fetchUserFollow: () => Promise.resolve(mocks.userFollowState.current),
  followUser: mocks.followUser,
  unfollowUser: mocks.unfollowUser,
}));
vi.mock('@/lib/perms', () => ({
  useSession: () => ({ session: { handle: 'Alenger', nickname: '爱兰琪尔', avatar: null, perms: [] }, isLoggedIn: true, isLoading: false }),
  can: () => mocks.canImpl.current,
}));

afterEach(() => {
  // 拆掉测试里装的 fetch 桩，别让它漏进别的用例（D73 那两条搬去了 topic.moderation.test.tsx）
  vi.unstubAllGlobals();
});

// state 可选：发帖页保存后回跳时带的 **{resubmitted:true}**（B6 那条要演它）
function SearchProbe() {
  const loc = useLocation();
  return <div data-testid='probe-search'>{loc.search}</div>;
}

function renderPage(state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(
    // D67 的用例需要拿这颗 QueryClient 断言「哪几段缓存被失效」，所以把它挂回返回值
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[{ pathname: '/t/' + WIRE.id, state }]}>
        <Routes>
          <Route path='/t/:topicId' element={<TopicPage />} />
          {/* 「编辑 / 重新提交」都跳发帖页编辑态：这里放一条探针，断言真的跳到了 /new?edit=<id> */}
          <Route path='/new' element={<SearchProbe />} />
          {/* 删帖成功后会回到分区页：不给这条路由，react-router 会往 stderr 打一行噪音 */}
          <Route path='*' element={<div />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return Object.assign(out, { qc });
}

it('整页画得出来：正文、四件右栏、审核横幅与理由、来源可点、来源标签用后端词表', async () => {
  renderPage();
  const main = await screen.findByTestId('topic-main');
  expect(main.querySelector('h1')?.textContent).toBe(WIRE.title);
  expect(screen.getByTestId('topic-rail').children.length).toBe(4);
  // review_state=rejected：横幅与 review_note 都要在（只有作者看得到，这条响应就是作者视角）
  expect(screen.getByTestId('review-banner').getAttribute('data-state')).toBe('rejected');
  expect(screen.getByText(/正文含未标明来源的下载地址/)).toBeTruthy();
  // 下载来源：真站是可点的转链（房间那份不可点）；行主名是作者写的 label，
  // provider=pan123 的站点名退成注脚（同一格还在链接里，词表没有回落成「其他」）。
  const source = screen.getByRole('link', { name: /打开 第三章整合包/ });
  expect(source.getAttribute('href')).toContain('/api/v1/topics/01a13540/sources/s1/go');
  expect(source.textContent).toContain('123 云盘');
  // 作者头像：avatar_hash 拼成 /img/<hash>（UserAvatar 挨着昵称时 alt 留空，所以按 src 找）
  expect(document.querySelector('img[src*="/img/a1b2c3"]')).toBeTruthy();
  // 反馈入口计数来自详情里的 issue_open_count
  expect(screen.getByTestId('issue-nudge-rail').textContent).toContain('7');
  // 作者角色徽标（拍板 08 §第三轮 3）：详情回了 role 就必须画出来。
  // 旧行为下这里是空的 —— 后端 UserBriefDTO 没有这一列，前端那行 shortcut 恒 null。
  // 按正则找：Ring 的 Tag 渲染出来是 data-testid='ring-tag role-badge'（它自己会加前缀）
  // 按**子串**查而不是 getByTestId：Ring 的 Tag 渲染出来是 data-testid='ring-tag role-badge'
  // （它自己会加 'ring-tag' 前缀），精确匹配查不到 —— 那种「找不到」与「没渲染」长得一样。
  // Ring 的 Tag 渲染出来是 **data-test**（不是 data-testid）：joinDataTestAttributes 只做拼接，
  // 转成 data-testid 的是别的控件。所以这里按 data-test 查 —— 用 getByTestId 会「找不到」，
  // 而那种找不到与「徽标根本没渲染」长得一模一样。
  const badge = document.querySelector('[data-test*="role-badge"]');
  expect(badge?.textContent).toBe('认证创作者');
});

// 任务 1+2（拍板 08 第三轮）：「关注分区」接真端点 + 那一格「成员」显真数。
// 旧行为下这两条都会红：member_count 写死 0、onJoin 只回一句「后端没有端点」——
// 判据就是**真数 128 与真请求**，而不是「有个数字」。
it('关注分区：成员数来自 GET /boards/{slug}/follow 的真数，点按钮打到同一对端点', async () => {
  mocks.followState.current = { target: 'board', slug: BOARD.slug, following: false, follower_count: 128 };
  renderPage();
  await screen.findByTestId('topic-main');
  // 「成员」那一格的数字（旧行为恒 0，这条必红）
  await waitFor(() => expect(screen.getByTestId('topic-rail').textContent).toContain('128'));
  fireEvent.click(screen.getByRole('button', { name: /关注分区/ }));
  await waitFor(() => expect(mocks.followBoard).toHaveBeenCalledWith(BOARD.slug));

  // 已关注那一档：按钮换成「已关注」，再点打到 DELETE（幂等取关用的是另一个动词）
  mocks.followState.current = { target: 'board', slug: BOARD.slug, following: true, follower_count: 128 };
  mocks.unfollowBoard.mockResolvedValue({ target: 'board', slug: BOARD.slug, following: false, follower_count: 127 });
  renderPage();
  await screen.findAllByTestId('topic-main');
  const unfollow = await screen.findByRole('button', { name: /已关注/ });
  fireEvent.click(unfollow);
  await waitFor(() => expect(mocks.unfollowBoard).toHaveBeenCalledWith(BOARD.slug));
  mocks.followState.current = { target: 'board', slug: BOARD.slug, following: false, follower_count: 0 };
});

it('can_reply=false：输入框换成引导登录那一块，评论区仍然可见', async () => {
  renderPage();
  await screen.findByTestId('topic-main');
  await waitFor(() => expect(screen.queryByTestId('comment-total')).toBeTruthy());
  expect(screen.queryAllByText(/登录后可以回复/).length + screen.queryAllByText(/还不能发帖回复/).length).toBeGreaterThan(0);
});

it('举报打到 POST /reports，字段名与后端 DTO 逐字一致（target_type / target_id / reason / detail）', async () => {
  renderPage();
  await screen.findByTestId('topic-main');
  fireEvent.click(screen.getByTestId('topic-report'));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(dialog.querySelectorAll('input[type=radio]')[0]!);
  fireEvent.click(dialog.querySelector('[data-testid=report-submit]')!);
  await waitFor(() =>
    expect(mocks.createReport).toHaveBeenCalledWith({
      target_type: 'topic',
      target_id: WIRE.id,
      reason: 'spam',
      detail: undefined,
    }),
  );
});

// B6（2026-10-15 改口径）：编辑不再在帖子页里改 —— 「编辑」与「重新提交审核」都是一条**去发帖页编辑态**的链接
// （/new?edit=<id>），PATCH 与「打回 pending」都在那边发生（那里的用例钉住了 content_md 是 Markdown）。
// 帖子页剩下的责任只有一条：**从发帖页回来时，把「这次是改完重提」说出来** ——
// 那个事实由导航 state 带回来（编辑保存才带），刷新后与首次投稿同形，这是有意的诚实。
it('B6：编辑与重新提交都是去发帖页的链接；从发帖页回来时横幅说清「已重新提交复审」', async () => {
  renderPage();
  await screen.findByTestId('topic-main');
  expect(screen.getByTestId('topic-edit').getAttribute('href')).toBe('/new?edit=' + WIRE.id);
  // 复审横幅上的那颗按钮走同一个落点（后端状态机没有 rejected → approved 这条边，只有「改完重提」）
  fireEvent.click(screen.getByTestId('topic-resubmit'));
  await waitFor(() => expect(screen.getByTestId('probe-search').textContent).toBe('?edit=' + WIRE.id));
  cleanup();

  // 保存成功后服务端把 review_state 从 rejected 打回 pending；发帖页回跳时带 state —— 横幅与回执都要说同一件事
  mocks.topic.current = { review_state: 'pending', review_note: null };
  renderPage({ resubmitted: true });
  await screen.findByTestId('topic-main');
  const banner = screen.getByTestId('review-banner');
  expect(banner.getAttribute('data-state')).toBe('pending');
  expect(banner.getAttribute('data-resubmitted')).toBe('1');
  expect(banner.textContent).toContain('已重新提交复审');
  expect(screen.getAllByTestId('design-action-note')[0]!.textContent).toContain('已重新提交审核');
  mocks.topic.current = null;
});

// D6 的同一条根因（帖子页的回复）：编辑器给的是 EditorState JSON，后端 posts.content_md 收的是 Markdown。
// 替身**照后端行为写**：POST 存下 content_md，回复列表接口回的就是它的渲染结果 ——
// 旧测试拿手写 HTML 当 content_html，所以「发上去的是不是 JSON」它根本看不见。
it('上行（回复）：POST /topics/{id}/posts 的 content_md 是 Markdown，不是 EditorState JSON', async () => {
  mocks.createPost.mockImplementation((_id: string, body: { content_md: string }) => {
    mocks.posts.current = {
      items: [
        {
          id: 'p-9',
          parent_id: null,
          floor: 2,
          author: { handle: 'Alenger', nickname: '爱兰琪尔', avatar_hash: null },
          content_md: body.content_md,
          content_html: '<p>' + body.content_md + '</p>',
          created_at: '2026-10-14T00:00:00Z',
          updated_at: '2026-10-14T00:00:00Z',
          like_count: 0,
          my_vote: 0,
        },
      ],
      next: null,
    };
    return Promise.resolve({});
  });
  // WIRE 的 can_reply 是 false（那是作者视角的审核态那条）：回复框要能画出来才谈得上提交
  mocks.topic.current = { can_reply: true };
  renderPage();
  await screen.findByTestId('topic-main');
  fireEvent.change(await screen.findByLabelText('假编辑器（测试注入）'), { target: { value: EDITOR_JSON } });
  fireEvent.click(screen.getByTestId('reply-publish'));

  await waitFor(() => expect(mocks.createPost).toHaveBeenCalledTimes(1));
  const [topicId, body] = mocks.createPost.mock.calls[0]! as [string, { content_md: string }];
  expect(topicId).toBe(WIRE.id);
  expect(body.content_md).toBe('走到第二波就卡关。');
  expect(JSON.stringify(body)).not.toContain('"root"');
  // 后端下一次取列表时，页面上看到的是正文本身（渲染的就是存下来的那一份），整页里没有 JSON 的形状
  await waitFor(() => expect(screen.getByText('走到第二波就卡关。')).toBeTruthy());
  expect(document.body.textContent ?? '').not.toContain('"root"');

  mocks.createPost.mockReset();
  mocks.topic.current = null;
  mocks.posts.current = null;
});

// L6（拍板）：「打回修改」是**独立状态**（不是 rejected）—— 作者侧文案与操作都要与「拒绝」不同，
// 而且要给「查看最后过审版本」的入口（原始版本已过审时显示它）。
// 判据：同一个 review_state 下，横幅的 data-state、标题、文案三样都与 rejected 不同，
// 并且点那个入口能看到后端给的 revision_of 正文。
it('L6：revision_requested 与「拒绝」是两套文案，且能查看最后过审版本', async () => {
  mocks.topic.current = {
    review_state: 'revision_requested',
    review_note: '第 3 段引用的来源没有标注出处，补一下',
    revision_of: {
      content_md: '上一版的正文',
      content_html: '<p>这是上一次过审时的正文。</p>',
      approved_at: '2026-10-13T02:00:00Z',
    },
  };
  renderPage();
  await screen.findByTestId('topic-main');

  const banner = screen.getByTestId('review-banner');
  expect(banner.getAttribute('data-state')).toBe('revision_requested');
  // 文案必须说清「不是被拒绝」（这正是「改改就能过」与「直接拒绝」的心理预期差别）
  expect(banner.textContent).toContain('需要修改后再审');
  expect(banner.textContent).toContain('这篇不是被拒绝');
  expect(banner.textContent).toContain('第 3 段引用的来源没有标注出处');
  // 与「拒绝」那一档的差异：拒绝才有「重新提交审核」，打回是「改完存下就自动回审核中」
  expect(screen.queryByTestId('topic-resubmit')).toBeNull();
  expect(banner.textContent).toContain('不需要另点一次提交');

  // 「查看最后过审版本」：点开能看到 revision_of 的正文（后端给的那一份，不是手上这一版）
  fireEvent.click(screen.getByTestId('topic-revision-view'));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('最后过审版本');
  expect(dialog.textContent).toContain('这是上一次过审时的正文。');
  mocks.topic.current = null;
});

// D67（2026-10-15 用户实测「首页卡片的评论数点进才见真数」）：回复列是 topics.reply_count 的
// **缓存快照** ——发 / 删回复只会失效帖内那两段缓存，['topics', …]（首页 / 分区页 / 搜索里的卡片）
// 与 ['profile', handle, 'topics']（个人主页）不洗牌的话，卡片上的数要等 30s 才对上。
// 用例判据就是这两段缓存的 isInvalidated：成功一次动作后它们必须变 true。
it('D67：回复 / 删回复之后，信息流与个人主页的列表缓存一并失效', async () => {
  mocks.posts.current = {
    items: [
      {
        id: 'p-mine',
        parent_id: null,
        floor: 2,
        author: { handle: 'Alenger', nickname: '爱兰琪尔', avatar_hash: null },
        content_md: '我自己的一条',
        content_html: '<p>我自己的一条</p>',
        created_at: '2026-10-13T01:00:00Z',
        updated_at: '2026-10-13T01:00:00Z',
        like_count: 0,
        my_vote: 0,
      },
    ],
    next: null,
  };
  mocks.createPost.mockResolvedValue({});
  mocks.deletePost.mockResolvedValue(null);
  mocks.topic.current = { can_reply: true };
  const { qc } = renderPage();
  await screen.findByTestId('topic-main');
  const feedKey = ['topics', { board: undefined, sort: 'latest' }] as const;
  const mineKey = ['profile', 'Alenger', 'topics'] as const;
  qc.setQueryData(feedKey, { data: [], next: null });
  qc.setQueryData(mineKey, { data: [], next: null });
  expect(qc.getQueryState(feedKey)?.isInvalidated).toBeFalsy();

  // 发一条回复：['topics'] 前缀 + ['profile'] 前缀都要失效（个人主页的 userTopics 在它下面）
  fireEvent.change(await screen.findByLabelText('假编辑器（测试注入）'), { target: { value: EDITOR_JSON } });
  fireEvent.click(screen.getByTestId('reply-publish'));
  await waitFor(() => expect(mocks.createPost).toHaveBeenCalled());
  await waitFor(() => expect(qc.getQueryState(feedKey)?.isInvalidated).toBe(true));
  await waitFor(() => expect(qc.getQueryState(mineKey)?.isInvalidated).toBe(true));

  // 删自己的回复：同一组失效
  mocks.createPost.mockClear();
  qc.setQueryData(feedKey, { data: [], next: null });
  qc.setQueryData(mineKey, { data: [], next: null });
  fireEvent.click(screen.getAllByTestId('comment-delete')[0]!);
  await waitFor(() => expect(mocks.deletePost).toHaveBeenCalledWith('p-mine'));
  await waitFor(() => expect(qc.getQueryState(feedKey)?.isInvalidated).toBe(true));
  expect(qc.getQueryState(mineKey)?.isInvalidated).toBe(true);

  mocks.createPost.mockReset();
  mocks.deletePost.mockReset();
  mocks.posts.current = null;
  mocks.topic.current = null;
});

it('删帖与删回复打到各自的端点（帖子级 / 楼层级是两个动作）', async () => {
  renderPage();
  await screen.findByTestId('topic-main');
  fireEvent.click(screen.getByTestId('topic-delete'));
  fireEvent.click(screen.getByTestId('topic-delete-confirm'));
  await waitFor(() => expect(mocks.deleteTopic).toHaveBeenCalledWith(WIRE.id));
});

// J3（拍板第二轮）：踩数是**按身份下发**的 —— 后端给普通用户 / 游客的 PostDTO 里**根本没有**
// `dislike_count` 这个键（dto.go 带 omitempty，只有管理员以上与内容作者拿得到）。
// 所以那一格要回答的是「**我自己**点没点」：状态来自 my_vote（后端一直给），不是数字。
//
// 为什么断言写成「按可读名找那颗按钮」而不是「里面没有数字」：**没有数字是两件事共有的结果**
// （后端没下发、或前端把 my_vote 读错成 0 都长这样），只有把「我踩过」做成按钮的可读名，
// 「显示的是我自己点没点」才是能被证伪的一句话。
it('J3：后端不下发 dislike_count 时，非特权用户看到的是「我自己点没点」，且不显示数字', async () => {
  mocks.posts.current = {
    items: [
      {
        id: 'p-2',
        parent_id: null,
        floor: 2,
        author: { handle: 'tang', nickname: '唐', avatar_hash: null },
        content_md: '我也踩了一脚。',
        content_html: '<p>我也踩了一脚。</p>',
        created_at: '2026-10-13T01:00:00Z',
        updated_at: '2026-10-13T01:00:00Z',
        like_count: 3,
        // **故意没有 dislike_count 这个键**：后端对普通用户 / 游客就是这么发的（DTO 的 omitempty）
        my_vote: -1,
      },
    ],
    next: null,
  };
  renderPage();
  await screen.findByTestId('topic-main');
  await screen.findByText('我也踩了一脚。');

  // 「我自己点过踩」：那颗按钮读作「取消点踩」（= 已经踩过），且带选中态
  const down = await screen.findByRole('button', { name: '取消点踩' });
  expect(down.className).toContain('ring-button-active');
  // 踩数没下发，界面不许替后端补一个 0 出来 —— 这一格里一个数字都没有
  expect(down.textContent).toBe('');
  // 反方向：没有哪一条是「没踩过」的形态 —— 否则「我点没点」就分不出来了
  expect(screen.queryByRole('button', { name: '点踩' })).toBeNull();
  mocks.posts.current = null;
});

// J3 的另一半（**守门**用例：改之前就是绿的，它防的是把「只有 number 才渲染」做成「永远不渲染」）：
// 后端下发了计数时（管理员以上 / 内容作者视角，PostDTO 的 dislike_count 存在），数字必须照旧在 ——
// 拍板说的是「点踩数据只对管理员及以上权限与内容发布者可见」，不是「谁都不给看」。
it('J3：后端下发了 dislike_count 时（管理员 / 作者视角），踩数照旧显示', async () => {
  mocks.posts.current = {
    items: [
      {
        id: 'p-3',
        parent_id: null,
        floor: 3,
        author: { handle: 'tang', nickname: '唐', avatar_hash: null },
        content_md: '这条被踩了七次。',
        content_html: '<p>这条被踩了七次。</p>',
        created_at: '2026-10-13T02:00:00Z',
        updated_at: '2026-10-13T02:00:00Z',
        like_count: 3,
        // 特权视角才有这个键（后端 ShowDislikeCount：管理员以上，或这一条是作者自己的）
        dislike_count: 7,
        my_vote: -1,
      },
    ],
    next: null,
  };
  renderPage();
  await screen.findByTestId('topic-main');
  const down = await screen.findByRole('button', { name: '取消点踩' });
  expect(down.textContent).toBe('7');
  expect(down.className).toContain('ring-button-active');
  mocks.posts.current = null;
});

// 「@ 提及候选」（拍板 08 §第三轮 4）：候选端点的接线与**候选 id 的形状**。
//
// 端点在拍板之前就有（`GET /search?type=users`，设计稿定的那个），所以这一条的验收不在
// 「端点存不存在」，而在**候选能不能真的用**：编辑器存进正文的是 `mention:<id>`，
// 而 id 必须是数字 user id（platform/mention 的 BodyRe 只收 \d{1,18}）。
// 后端那一半由 forum/internal/user/mention_search_test.go 钉住（改前编译即红）；
// 这里钉前端这一半：**没敲 @ 不发查询**（后端对空词回 400），以及三列映射。
it('提及候选：敲 @ 之前不发查询，候选的 id 就是 mention: 里那个数字 user id', async () => {
  mocks.searchUsers.mockResolvedValue([
    { id: 7, handle: 'tangtian', nickname: '唐天', avatar: '/img/tang', level: 3, ambiguous: true },
  ]);
  renderPage();
  await screen.findByTestId('topic-main');
  // 没敲 @ 之前不发这次查询（q 为空后端 400，而且每次进页面都发是白花钱）
  expect(mocks.searchUsers).not.toHaveBeenCalled();

  // 候选件的三列映射：id 原样（数字真源）、avatar 不重复拼前缀、ambiguous → duplicate
  const got = toMentionCandidates([
    { id: 7, handle: 'tangtian', nickname: '唐天', avatar: '/img/tang', level: 3, ambiguous: true },
  ]);
  expect(got).toEqual([{ id: '7', handle: 'tangtian', nickname: '唐天', avatar: '/img/tang', duplicate: true }]);
});

// 「已转人工」那一档（拍板 08 §第三轮 6）：pending 下面其实是两件事 ——「AI 正在自动检查，几十秒」
// 与「已经在人工队列里，等一个人」。后端按 review_events **最新一条**判定算（forum/pgsql/topics.go），
// 这里钉前端那一半：字段一到，横幅就说「已转人工」那一套文案。
it('审核横幅：后端说已转人工时，文案换成「已转人工」而不是「正在自动检查」', async () => {
  // 先把「自动检查」那一档拍下来当对照（WIRE 的 review_state=rejected，先切成待审）
  mocks.topic.current = { review_state: 'pending', review_note: null };
  renderPage();
  await screen.findByTestId('topic-main');
  expect(screen.getByTestId('review-banner').textContent).toContain('正在自动检查');

  // 再喂一版「已转人工」（先把上一版从 DOM 里清掉，否则两次渲染的横幅都在文档里）
  cleanup();
  mocks.topic.current = { review_state: 'pending', review_note: null, review_pending_human: true };
  renderPage();
  await screen.findByTestId('topic-main');
  const banner = screen.getByTestId('review-banner');
  expect(banner.textContent).toContain('已转人工');
  expect(banner.textContent).not.toContain('正在自动检查');
  // 「谁在判」那一层也要说清（作者最想知道的是「还要等多久」）
  expect(banner.textContent).toContain('1 个工作日内有结果');
  mocks.topic.current = null;
});

// 作者关注（D19，用户实测「右侧根本没有关注按钮，怀疑根本没做」）：
// 后端 PUT/DELETE /users/{handle}/follow 早就有了（K-REL 的 L5），**前端一直零调用** ——
// 这条盯宿主接线本身：自己看自己不画；看别人时那颗按钮出现、点了真的打到那条端点。
it('作者关注：自己看自己不画按钮；看别人时点了真的调 /users/{handle}/follow', async () => {
  // ① 自己看自己：WIRE 的作者就是登录者（Alenger），按钮必须不出现
  renderPage();
  await screen.findByTestId('topic-main');
  expect(screen.queryByTestId('author-follow')).toBeNull();

  // ② 看别人：换掉作者 handle，按钮出现，点了调 followUser
  cleanup();
  mocks.topic.current = { author: { ...WIRE.author, handle: 'someone-else', nickname: '别人' } };
  renderPage();
  const btn = await screen.findByTestId('author-follow');
  fireEvent.click(btn);
  await waitFor(() => expect(mocks.followUser).toHaveBeenCalledWith('someone-else'));
  mocks.topic.current = null;
});
