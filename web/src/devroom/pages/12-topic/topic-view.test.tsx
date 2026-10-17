import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TopicView, type TopicViewProps } from './topic-view';
import type { Board, BoardNav, TopicAuthor, TopicDetail } from './types';
import type { BoardSummary } from '@/devroom/pages/03-navigation/board-rail';
import { DEFAULT_COVER_ART } from '@/ui/topic/default-cover';
import type { CommentData } from '@/ui/comment/types';

// 这一条盯的是「房间与真站共用的那一份版式」：
//   ① 三栏与右栏四件都在（原来真站只有分区列表与两张自拼的卡）；
//   ② 每条去处都**由宿主给**（分区 / 作者 / 发帖 / 来源能不能点）—— 组件自己拼路径会在 /dev/ 下坏一处；
//   ③ 举报、编辑、重新提交审核三条断链真的能走通（盲审二号 ③/13 报的）。
// 断言只查语义（角色 / testid / 文案片段），不查 className。

const BOARD: Board = {
  slug: 'custom-campaign',
  name: '自制战役',
  cover_hash: '',
  description: '玩家自制战役与地图。',
  topic_count: 12,
  post_count: 30,
  member_count: 5,
  today_count: 1,
  joined: false,
  hint: '自制战役与地图',
};
const NAV: BoardNav[] = [
  { key: 'all', label: '全部', count: 12 },
  { key: 'resource', label: '资源' },
];
const AUTHOR: TopicAuthor = {
  handle: 'demo-admin',
  nickname: '示范管理员',
  avatar: '',
  role: null,
  title: { name: '执政官', color: '#2563eb' },
  bio: '战役作者。',
  level: 27,
  exp: 640,
  exp_max: 1000,
  topic_count: 86,
  like_received: 12480,
  joined_at: '2024 年 3 月',
};
const TOPIC: TopicDetail = {
  id: 't_1042',
  board: { slug: 'custom-campaign', name: '自制战役' },
  kind: 'resource',
  title: '第三章「余烬」平衡性改动说明',
  // 正文真源（Lexical EditorState 的 JSON）：编辑弹层把它灌回 MarkdownEditor。
  // 这里放的是**含一段文字的最小文档**，所以编辑框里本来就该有内容。
  content_md: JSON.stringify({
    root: {
      children: [
        {
          children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: '正文第一段。', type: 'text', version: 1 }],
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
  }),
  content_html: '<p>正文第一段。</p>',
  author: AUTHOR,
  created_at: '2026-10-12 09:20',
  updated_at: '今天 11:04',
  reply_count: 3,
  like_count: 236,
  view_count: 4203,
  bookmark_count: 74,
  pinned: true,
  featured: true,
  locked: false,
  sources: [
    {
      id: 's1',
      provider: 'baidu',
      label: '第三章整合包',
      go_path: '/api/v1/topics/t_1042/sources/s1/go',
      extraction_code: 'sc2c',
      size: '2.4 GB',
      verified_at: '今天 09:20',
      upkeep: 'active',
    },
  ],
  images: [],
  viewer: { liked: false, bookmarked: true, following: false },
};
const COMMENTS: CommentData[] = [
  {
    id: 'c1',
    author: { handle: 'demo-marine', nickname: '陆战队员' },
    body: '<p>改完的通了一遍。</p>',
    createdAt: '3 小时前',
    likes: 42,
    dislikes: 1,
  },
];

function viewProps(over: Partial<TopicViewProps> = {}): TopicViewProps {
  return {
    boards: [BOARD],
    board: BOARD,
    boardNav: NAV,
    boardHref: (slug) => '/b/' + slug,
    navValue: 'all',
    onNavChange: vi.fn(),
    composeHref: '/new?board=custom-campaign',
    authorHref: '/u/demo-admin',
    author: AUTHOR,
    topic: TOPIC,
    review: { state: 'approved' },
    canEdit: true,
    liked: false,
    bookmarked: true,
    likeCount: 236,
    bookmarkCount: 74,
    onToggleLike: vi.fn(),
    onToggleBookmark: vi.fn(),
    onCopyLink: vi.fn(),
    onSubmitReport: vi.fn(),
    reported: false,
    reportedIds: [],
    onDelete: vi.fn(),
    comments: COMMENTS,
    commentTotal: 3,
    candidates: [],
    me: { handle: 'demo-marine', nickname: '陆战队员', avatar: null },
    onSubmitComment: vi.fn(),
    onDeleteComment: vi.fn(),
    onVoteComment: vi.fn(),
    channels: [],
    issueCount: 7,
    feedbackHref: '?page=13-issue',
    onOpenIssue: vi.fn(),
    ...over,
  };
}

it('三栏与右栏四件都在，页签有两个', async () => {
  const { container } = render(<TopicView {...viewProps()} />);
  expect(container.querySelectorAll('[data-testid=topic-tabs] button').length).toBe(2);
  // 左栏：分区列表 + 分区内导航（原来真站只有分区列表）
  const left = screen.getByLabelText('分区与分区内导航');
  expect(left.querySelectorAll('a[href^="/b/"]').length).toBe(1);
  expect(left.querySelectorAll('section button').length).toBe(NAV.length);
  // 中栏：全文 + 下载来源 + 动作条 + 评论区
  const main = screen.getByTestId('topic-main');
  expect(main.querySelector('h1')?.textContent).toBe(TOPIC.title);
  // 评论区是懒加载模块（Lexical 不进首屏），所以它会晚一拍出现；
  // 全套并发跑时这一拍的抖动实测超过 1s（findBy 的默认窗口），给足 3s（与 949be1c 修 home.test 同一个处理）
  expect((await screen.findByTestId('comment-total', undefined, { timeout: 3000 })).textContent).toBe('3');
  // 右栏四件（顺序照设计稿）
  expect(screen.getByTestId('topic-rail').children.length).toBe(4);
  expect(screen.getByTestId('issue-nudge-rail')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('issue-nudge-inline')).toBeTruthy());
});

it('每条去处都由宿主给：发帖、作者主页、来源在 linked 时才可点', async () => {
  const { rerender } = render(<TopicView {...viewProps()} />);
  expect(screen.getByRole('link', { name: /发帖/ }).getAttribute('href')).toBe('/new?board=custom-campaign');
  expect(screen.getByRole('link', { name: /查看主页/ }).getAttribute('href')).toBe('/u/demo-admin');
  // 房间里没有转链端点：来源默认不可导航（不是一条会把人带出房间的死链）
  await screen.findByTestId('comment-total');
  expect(screen.queryByRole('link', { name: /百度网盘/ })).toBeNull();
  // linked=true 才是真链接（真站）
  rerender(<TopicView {...viewProps({ sourcesLinked: true })} />);
  expect(screen.getByRole('link', { name: /百度网盘/ }).getAttribute('href')).toBe(TOPIC.sources[0]!.go_path);
});

// D4（2026-10-14 用户实测）：下载来源要**在正文上方**、紧凑一行、点它开新标签页。
// 三条都是用「能证伪」的判据写的：DOM 顺序比位置 / 链接属性 / 行的形状（站点名 + 来源名 + 提取码同行）。
it('D4：下载来源在正文上方，且整行是可新标签页打开的转链链接', async () => {
  const { container } = render(<TopicView {...viewProps({ sourcesLinked: true })} />);
  await screen.findByTestId('comment-total');

  const link = screen.getByRole('link', { name: /百度网盘/ });
  const body = container.querySelector('[data-testid=topic-main] .prose');
  expect(body).toBeTruthy();
  // ① 顺序：来源那一行必须排在正文之前（原来它在正文与评论区之间）。
  //    用「来源标题 == FOLLOWING 正文」而不是拿 testid 找块：判据落在**用户看得见的位置关系**上。
  const heading = screen.getByRole('heading', { name: /下载来源/ });
  expect(heading.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // ② 一行装下「图标 + 站点名 + 来源名 + 提取码」：站点名与来源名是同一个 <a> 里的两格
  expect(link.textContent).toContain('第三章整合包');
  expect(link.textContent).toContain('提取码');
  expect(link.textContent).toContain('sc2c');
  expect(link.getAttribute('href')).toBe(TOPIC.sources[0]!.go_path);
  // ③ 当前页不许被带走（转链是服务端 302 到网盘）：新标签页 + noopener noreferrer（D61）
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

// D60（2026-10-15 用户实测「下载源名称猜不中显示其他」）：topic_sources.label 是**用户自定义名**，
// 行的主名优先用它；label 空着的行也不能只剩一个「其他」—— 用原始链接的主机名让这条源可辨认。
it('D60：来源行的主名是作者写的 label，label 空时回落站点名并摆出链接主机名', async () => {
  const withLabel = render(<TopicView {...viewProps({ sourcesLinked: true })} />);
  await screen.findByTestId('comment-total');
  // 主名 = label（第三章整合包），站点名（百度网盘）退为注脚 —— 顺序即优先级
  const link = screen.getByRole('link', { name: /第三章整合包/ });
  expect(link.textContent!.indexOf('第三章整合包')).toBeLessThan(link.textContent!.indexOf('百度网盘'));
  withLabel.unmount();

  // label 空 + provider 在词表外（老库的 netdisk 也算）：站点回落「其他」时主名还必须有料 —— 主机名
  const bare = {
    ...TOPIC,
    sources: [{ id: 's2', provider: 'other', label: '', go_path: '/api/v1/go', url: 'https://cdn.example.net/miyin.exe', size: '', verified_at: '', upkeep: 'active' as const }],
  };
  render(<TopicView {...viewProps({ topic: bare, sourcesLinked: true })} />);
  const link2 = screen.getByRole('link', { name: /cdn\.example\.net/ });
  expect(link2.textContent).toContain('其他');
  expect(link2.textContent).toContain('cdn.example.net');
  expect(link2.textContent!.trim().length).toBeGreaterThan('其他'.length); // 不再是一行只有「其他」
});

// D8（2026-10-14 用户实测）：帖子里两个发帖者都点不进主页 —— 私信/看 TA 的帖子整条测不了。
it('D8：正文头部与右栏作者卡的头像/昵称都点得进 /u/<handle>', async () => {
  const { container } = render(<TopicView {...viewProps()} />);
  await screen.findByTestId('comment-total');
  const cards = [...container.querySelectorAll('[data-testid=topic-main] a[href], [data-testid=topic-rail] a[href]')].filter(
    (a) => a.getAttribute('href') === '/u/demo-admin' && a.textContent.includes('示范管理员'),
  );
  // 两处各一条（正文头部的作者行 + 右栏作者卡的头像/昵称），而不是只有底下一行「查看主页」
  expect(cards.length).toBeGreaterThanOrEqual(2);
});

// D21（2026-10-15 用户实测「帖子页内左侧依旧不显示分区封面」）：左栏的分区列表**必须就是**
// 03-navigation 的 BoardRail（DevRoom 03 与首页 / 分区页都在渲染同一个文件），字段是后端 BoardDTO 的
// cover_hash（forum/internal/forum/dto.go:43）。旧行为：12-topic 自己又画了一份行，读的是设计稿的
// `cover` —— BoardDTO 里根本没有这一列，所以真站恒为空 → 恒灰块（用户看到的就是这个）。
it('D21：左栏分区列表画封面（cover_hash → /img/<hash>），没有封面的那一行落默认封面图', () => {
  const boards: BoardSummary[] = [
    { slug: 'custom-campaign', name: '自制战役', cover_hash: 'abc123', description: '玩家自制战役与地图', topic_count: 10 },
    { slug: 'emperor', name: '皇帝区', cover_hash: '', description: '', topic_count: 0 },
  ];
  render(<TopicView {...viewProps({ boards })} />);
  const rows = screen.getByLabelText('分区与分区内导航').querySelectorAll('a[href^="/b/"]');
  expect(rows.length).toBe(2);
  // 有封面：真的画图，地址是 /img/<裸哈希>（走 imagePath，带前缀）
  expect(rows[0]!.querySelector('img')?.getAttribute('src')).toBe('/img/abc123');
  // 没有封面：落**全站唯一那份默认封面**（美术资产那张弥音），不是空白、也不是裂图。
  // 旧行为是「首字 + slug 色相」的色块 —— 用户 2026-10-15 判定不要那个字。
  expect(rows[1]!.querySelector('img')?.getAttribute('src')).toBe('/art/' + DEFAULT_COVER_ART);
});

it('举报：弹层里先选事由才让提交，提交后把 target 一起交给宿主', async () => {
  const onSubmitReport = vi.fn();
  render(<TopicView {...viewProps({ onSubmitReport })} />);
  fireEvent.click(screen.getByTestId('topic-report'));
  const dialog = await screen.findByRole('dialog');
  // Ring 的 Dialog 渲染在 portal 里（不在 render 的 container 底下），所以从 dialog 上找
  // 不选事由直接提交 → 有提示，且不回调（管理员按事由分类，空事由进队列没法处理）
  fireEvent.click(dialog.querySelector('[data-testid=report-submit]')!);
  expect(dialog.querySelector('[role=alert]')).toBeTruthy();
  expect(onSubmitReport).not.toHaveBeenCalled();
  // 选第一条事由再提交
  fireEvent.click(dialog.querySelectorAll('input[type=radio]')[0]!);
  fireEvent.click(dialog.querySelector('[data-testid=report-submit]')!);
  expect(onSubmitReport).toHaveBeenCalledWith('spam', '', null);
  // 提交后弹层自己收起来（房间与真站都靠这一层收口）
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('审核态：rejected 显示理由与「重新提交审核」，approve 后整条横幅消失', async () => {
  const onResubmit = vi.fn();
  const { rerender } = render(
    <TopicView {...viewProps({ review: { state: 'rejected', note: '正文含未标明来源的下载地址' }, onResubmit })} />,
  );
  expect(screen.getByText(/正文含未标明来源的下载地址/)).toBeTruthy();
  fireEvent.click(screen.getByTestId('topic-resubmit'));
  expect(onResubmit).toHaveBeenCalled();
  rerender(<TopicView {...viewProps()} />);
  expect(screen.queryByTestId('topic-resubmit')).toBeNull();
});

// D5（2026-10-14 用户实测）：点「问题反馈」页签**要真的切过去**。
// 这一层只证明回调到位（真站的导航在 routes/topic.tsx，判据是地址真的变了 —— 见 issues.tabs.test.tsx）；
// 同时钉住「宿主没接时不静默」：至少页签自己会选中，而不是一块点了没反应的死按钮。
it('D5：点「问题反馈」页签把 onOpenIssue 交给宿主', async () => {
  const onOpenIssue = vi.fn();
  const { container } = render(<TopicView {...viewProps({ onOpenIssue })} />);
  fireEvent.click(container.querySelectorAll('[data-testid=topic-tabs] button')[1]!);
  expect(onOpenIssue).toHaveBeenCalledTimes(1);
});

it('D5：宿主不接 onOpenIssue 时，页签自己也要选中（不许静默）', async () => {
  const { container } = render(<TopicView {...viewProps({ onOpenIssue: undefined })} />);
  const tabs = container.querySelectorAll('[data-testid=topic-tabs] button');
  fireEvent.click(tabs[1]!);
  expect(container.querySelectorAll('[data-testid=topic-tabs] button')[1]!.getAttribute('aria-current')).toBe('page');
});

it('四个反馈入口各是一条带了各自类型的链接（B2）', async () => {
  const issueHrefFor = vi.fn((kind: string) => '/issues?topic=t_1042&kind=' + kind);
  render(<TopicView {...viewProps({ issueHrefFor, feedbackHref: '/issues?topic=t_1042' })} />);
  // 每个类型一条地址：点哪一类就把哪一类带进去（原先四个按钮共用一条 href，kind 丢了）
  for (const [name, kind] of [
    [/^汇报 Bug/, 'bug'],
    [/^功能建议/, 'feature'],
    [/^难度建议/, 'difficulty'],
    [/^其他反馈/, 'other'],
  ] as const) {
    expect(screen.getByRole('link', { name }).getAttribute('href')).toBe('/issues?topic=t_1042&kind=' + kind);
  }
  // 两处入口（正文末尾 + 右栏）各四个按钮 —— 用容器的 testid 区分，别靠可访问名（两处同名）
  expect(screen.getByTestId('issue-nudge-inline').querySelectorAll('a[href]')).toHaveLength(5); // 四类 + 「看全部反馈」
  // 右栏那一格只有一个「去反馈页」（它不带类型）
  expect(screen.getByTestId('issue-nudge-rail').querySelectorAll('a[href]')).toHaveLength(1);
  // 「看全部反馈」不带 kind：那一页自己按页签选
  expect(screen.getAllByRole('link', { name: '看全部反馈' })[0]!.getAttribute('href')).toBe('/issues?topic=t_1042');
});

// 讨论帖不做问题反馈（用户原话：那是给可下载内容 / 地图的问题单）：
// 宿主把 issuesEnabled 关掉，页签与两处反馈入口**整块**都不画 —— 不是「计数为 0 恰好没药丸」，
// 所以这里给了一个非 0 的 issueCount，且断言的是 testid 不在，而不是文案不出现。
// 默认（不传）= true，房间产物照旧（房间那一屏是设计样板间，不许因此变样）。
it('讨论帖：issuesEnabled=false 时页签与两处反馈入口都不渲染；不传仍是两件都在', () => {
  const off = render(<TopicView {...viewProps({ issuesEnabled: false })} />);
  expect(off.container.querySelectorAll('[data-testid=topic-tabs] button').length).toBe(1);
  expect(off.container.querySelector('[data-testid=topic-tab-issue]')).toBeNull();
  expect(screen.queryByTestId('issue-nudge-inline')).toBeNull();
  expect(screen.queryByTestId('issue-nudge-rail')).toBeNull();
  off.unmount();

  const on = render(<TopicView {...viewProps()} />);
  expect(on.container.querySelectorAll('[data-testid=topic-tabs] button').length).toBe(2);
  expect(screen.getByTestId('issue-nudge-rail')).toBeTruthy();
  expect(screen.getByTestId('issue-nudge-inline')).toBeTruthy();
});

it('编辑与删帖：不给宿主的跳转地址与回调就不渲染入口；给了就**去发帖页**（帖内小弹层已撤除）', () => {
  const editHref = vi.fn((id: string) => '/new?edit=' + encodeURIComponent(id));
  render(<TopicView {...viewProps({ editHref })} />);
  const btn = screen.getByTestId('topic-edit');
  expect(btn.getAttribute('href')).toBe('/new?edit=' + encodeURIComponent('t_1042'));
  expect(editHref).toHaveBeenCalledWith('t_1042');

  // 删除入口的显隐规则不变（宿主不给就不渲染）
  const second = render(<TopicView {...viewProps({ editHref: undefined, onDelete: undefined })} />);
  expect(second.container.querySelector('[data-testid=topic-edit]')).toBeNull();
  expect(second.container.querySelector('[data-testid=topic-delete]')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull(); // 编辑不再是帖内弹层
});
