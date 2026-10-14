import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TopicView, type TopicViewProps } from './topic-view';
import type { Board, BoardNav, TopicAuthor, TopicDetail } from './types';
import type { CommentData } from '@/ui/comment/types';

// 这一条盯的是「房间与真站共用的那一份版式」：
//   ① 三栏与右栏四件都在（原来真站只有分区列表与两张自拼的卡）；
//   ② 每条去处都**由宿主给**（分区 / 作者 / 发帖 / 来源能不能点）—— 组件自己拼路径会在 /dev/ 下坏一处；
//   ③ 举报、编辑、重新提交审核三条断链真的能走通（盲审二号 ③/13 报的）。
// 断言只查语义（角色 / testid / 文案片段），不查 className。

const BOARD: Board = {
  slug: 'custom-campaign',
  name: '自制战役',
  cover: '',
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
    onEdit: vi.fn(),
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
  expect(screen.queryByRole('link', { name: /打开 百度网盘/ })).toBeNull();
  // linked=true 才是真链接（真站）
  rerender(<TopicView {...viewProps({ sourcesLinked: true })} />);
  expect(screen.getByRole('link', { name: /打开 百度网盘/ }).getAttribute('href')).toBe(TOPIC.sources[0]!.go_path);
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

it('四个反馈入口各是一条带了各自类型的链接（B2）', async () => {
  const issueHrefFor = vi.fn((kind: string) => '/issues?topic=t_1042&kind=' + kind);
  render(<TopicView {...viewProps({ issueHrefFor, feedbackHref: '/issues?topic=t_1042' })} />);
  // 每个类型一条地址：点哪一类就把哪一类带进去（原先四个按钮共用一条 href，kind 丢了）
  for (const [name, kind] of [
    [/^报个 Bug/, 'bug'],
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

it('编辑与删帖：不给回调就不渲染入口，给了就真的走宿主', async () => {
  const onEdit = vi.fn();
  render(<TopicView {...viewProps({ onEdit })} />);
  fireEvent.click(screen.getByTestId('topic-edit'));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(dialog.querySelector('input')!, { target: { value: '改过的标题' } });
  fireEvent.click(dialog.querySelector('[data-testid=edit-save]')!);
  expect(onEdit).toHaveBeenCalledWith({ title: '改过的标题', text: '正文第一段。' });

  const { container } = render(<TopicView {...viewProps({ onEdit: undefined, onDelete: undefined })} />);
  expect(container.querySelector('[data-testid=topic-edit]')).toBeNull();
  expect(container.querySelector('[data-testid=topic-delete]')).toBeNull();
});
