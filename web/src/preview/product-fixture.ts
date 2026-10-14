import { adminFixtureFor, ME_ADMIN } from './admin-fixtures';
// 产品预览入口的数据桩（`web/product.html`，只在 vite.preview.config.ts 里构建 —— 不进产品产物）。
//
// 为什么要它：产品路由页（/ 、/messages 、/issues …）此前**出不了图** —— vite.preview.config.ts 只收
// preview/devroom/isolate 三个入口，而本机默认没有后端（127.0.0.1:8080 没起），页面只会停在加载态。
// 前任们各自临时改配置再删（src/tmp-w2-preview.tsx / shots/w3-shot.ts）。这份是长期的。
//
// 形状照后端 DTO 抄（forum/internal/**、notify/types.go、message/types.go），**不照 DevRoom 的 mock 抄**：
// 桩的字段名一旦与真接口不一致，出出来的图就是一张假图（本仓库出现过多次，见交接单 §5.1）。
//
// 只在 `?stub=1`（默认）时挂上 window.fetch；`?stub=0` 时不碰，于是能对着真后端出图。
// shortcut: 只实现「列表页要用的那几条端点」，每条给一页数据；要演分页/错误态再加，
//   到那时更该做的是给这个桩加一个 ?state= 参数，而不是继续往里堆分支。
type Reply = { status?: number; body?: unknown };
type FixtureRequest = { url: string; method: string; body?: unknown };

// 管理后台的桩在同目录的 admin-fixtures.ts（product-fixture.ts 已经接近体量上限）。

const USER = (handle: string, nickname: string, role?: unknown) => ({
  handle,
  nickname,
  avatar_hash: null,
  avatar_small_hash: null,
  avatar: null,
  role: role ?? null,
  title: null,
});

const ME = {
  id: 'u-1',
  handle: 'demo-marine',
  nickname: '陆战队员',
  avatar: null,
  email_verified: true,
  perms: ['topic.create', 'topic.edit.own', 'issue.create'],
  is_super: false,
  role: { key: 'member', name: '成员' },
};

const SITE = { name: 'SC2clud', announcements: [], banner: null };

const BOARD = { slug: 'custom-campaign', name: '自制战役' };
const BOARDS = [
  { slug: 'announcement', name: '公告', description: '站点公告与版本发布。', cover: null, topic_count: 6, post_count: 41, today_count: 1 },
  BOARD,
  { slug: 'tool-dev', name: '工具与开发', description: '编辑器、触发器、数据表。', cover: null, topic_count: 23, post_count: 180, today_count: 3 },
  { slug: 'emperor', name: '皇帝区', description: '需要权限的分区。', cover: null, topic_count: 3, post_count: 12, today_count: 0 },
];

const TOPIC = (id: string, title: string, kind: string, author: unknown, replies: number, excerpt: string) => ({
  id,
  board: BOARD,
  kind,
  title,
  author,
  reply_count: replies,
  like_count: 42,
  view_count: 1893,
  // 字段名照后端 TopicCardDTO：精华是 bool（不是设计稿的 featured_at 时间戳）
  featured: false,
  pinned: false,
  created_at: '2026-10-12T09:20:00Z',
  last_reply_at: '2026-10-14T02:00:00Z',
  cover_hash: null,
  excerpt,
  viewer: { liked: false, bookmarked: false },
});

const TOPICS = [
  TOPIC('tp-1', '第三章「余烬」发布：隐藏结局与平衡性改动', 'resource', USER('demo-admin', '示范管理员'), 128, '这一章加了七张图、一条隐藏结局线，改动说明与下载都在正文里。'),
  TOPIC('tp-2', '触发器里 Wait 之后变量被清空，是我写法不对吗', 'discussion', USER('demo-voidray', '虚空辉光舰'), 12, '每次 Wait 完局部变量就没了，想确认是不是要用静态参数。'),
  TOPIC('tp-3', '【转载】SC2 编辑器常见坑位整理（2024 版）', 'repost', USER('demo-marine', '陆战队员'), 7, '整理自社区帖，标注了原作者与出处。'),
];

const TOPIC_DETAIL = {
  ...TOPICS[0],
  content_md: null,
  content_html:
    '<p>第三章「余烬」已经发布。这一版主要做三件事：隐藏结局线、菌毯铺速回调、以及读档后事件计时改为任务时间。</p><p>下载与提取码见右侧来源区；遇到问题请点下面的反馈入口。</p>',
  updated_at: '2026-10-14T02:00:00Z',
  bookmark_count: 74,
  locked: false,
  featured: true,
  images: [],
  sources: [
    {
      id: 's1',
      provider: 'baidu',
      label: '第三章整合包 2.4 GB',
      go_path: '/api/v1/topics/tp-1/sources/s1/go',
      url: 'https://pan.baidu.com/s/xxxx',
      extraction_code: 'sc2c',
      size: '2.4 GB',
      verified_at: '2026-10-14T01:00:00Z',
      upkeep: 'active',
    },
  ],
  author: { ...USER('demo-admin', '示范管理员', { key: 'admin', name: '管理员' }), bio: '战役作者。', level: 27, joined_at: '2024-03-02T00:00:00Z' },
  review_state: 'approved',
  review_note: null,
  issue_open_count: 2,
  can_edit: false,
  can_reply: true,
};

const POSTS = [
  {
    id: 'p-1',
    parent_id: null,
    author: USER('demo-voidray', '虚空辉光舰'),
    content_html: '<p>通了，隐藏结局在 15:00 前到废墟确实能触发，是我之前存档太旧。</p>',
    like_count: 12,
    dislike_count: 0,
    my_vote: 0,
    created_at: '2026-10-13T04:00:00Z',
  },
];

const NOTICE = (id: string, kind: string, payload: Record<string, unknown>, link: string) => ({
  id,
  kind,
  payload,
  link,
  read_at: null,
  created_at: '2026-10-14T02:00:00Z',
  actor: USER('demo-admin', '示范管理员'),
});

const NOTIFICATIONS: Record<string, unknown[]> = {
  reply: [NOTICE('n-1', 'reply', { text: '回复了你的主题「触发器里 Wait 之后变量被清空」' }, '/t/tp-2')],
  mention: [NOTICE('n-2', 'mention', { text: '在「第三章余烬」里 @ 了你' }, '/t/tp-1')],
  like: [NOTICE('n-3', 'like', { text: '赞了你的回复' }, '/t/tp-2')],
  'system,review,sanction,reward': [
    NOTICE('n-4', 'review', { state: 'approved', text: '你发布的主题通过了审核' }, '/t/tp-3'),
    NOTICE('n-5', 'sanction', { text: '你在「公告」分区被禁言 3 天', until: '2026-10-17T00:00:00Z' }, ''),
    NOTICE('n-6', 'reward', { text: '收到打赏', amount_cents: 1000 }, '/u/demo-marine'),
  ],
};

const ISSUE = (id: string, number: number, kind: string, title: string, status: string, tags: string[], count: number) => ({
  id,
  number,
  kind,
  title,
  status,
  author: USER('demo-voidray', '虚空辉光舰'),
  assignee: USER('demo-admin', '示范管理员'),
  tags,
  comment_count: count,
  created_at: '2026-10-10T04:00:00Z',
  updated_at: '2026-10-14T02:00:00Z',
  closed_at: status === 'closed' ? '2026-10-13T02:00:00Z' : null,
  topic_id: 'tp-1',
  topic_title: '第三章「余烬」发布：隐藏结局与平衡性改动',
  board: BOARD,
});

const ISSUES = [
  ISSUE('i-128', 128, 'bug', '第三章隐藏结局在 15:00 前抵达也不触发', 'open', ['战役', '阻塞'], 2),
  ISSUE('i-126', 126, 'difficulty', '第十一张图菌毯铺速太快，普通难度也劝退', 'open', ['平衡性'], 1),
  ISSUE('i-125', 125, 'other', '启动器下载页在 4K 屏上按钮被挤出可视区', 'open', ['界面'], 0),
  ISSUE('i-124', 124, 'bug', '第一章读档后英雄等级回到 1 级', 'closed', ['存档'], 1),
];

const ISSUE_COMMENTS = [
  {
    id: 'c-1',
    parent_id: null,
    body_html: '<p>确认是 bug：事件计时用的是读档之后的时间。下个补丁改成任务时间。</p>',
    author: USER('demo-admin', '示范管理员'),
    like_count: 12,
    dislike_count: 0,
    my_vote: 1,
    created_at: '2026-10-11T04:00:00Z',
    updated_at: '2026-10-11T04:00:00Z',
  },
];

const CONVERSATION = {
  peer: USER('demo-admin', '示范管理员'),
  unread_count: 1,
  last: { body: '补丁已经推上去了，你再试试那张图。', created_at: '2026-10-14T02:00:00Z' },
};

const THREAD = {
  peer: USER('demo-admin', '示范管理员'),
  // 字段名照 message/types.go 的 MessageDTO：**必须有 mine**（不是从 from 推出来的）——
  // 真实 DTO 里 mine 是独立字段，桩少给一个就等于把「撤回」那条界面分支永远遮住了（G2 出图要它）。
  items: [
    { id: 'm-1', body: '第三章的隐藏结局已经修好了。', mine: false, read: true, created_at: '2026-10-14T01:00:00Z' },
    { id: 'm-2', body: '好，我今晚过一遍。', mine: true, read: true, created_at: '2026-10-14T01:30:00Z' },
  ],
};

/** 一条请求 → 一条响应；undefined = 不拦（交回真实的 fetch）。顺序敏感：具体路径写在前面。 */
export function fixtureFor(u: string, method: string): Reply | undefined {
  const url = new URL(u, 'http://stub');
  const p = url.pathname;
  // 管理后台（/admin/*）：自己的桩，具体路径写在那一份里
  const admin = adminFixtureFor(u);
  if (admin !== undefined) return admin;
  // 游客态：?me=0（真后端「没登录」也是 200 + data:null，不是报错）
  // ?asAdmin=1 换成管理员身份：后台每一屏都要 perms，而这里的默认身份是普通成员。
  if (p.endsWith('/api/v1/me')) {
    const q = new URLSearchParams(location.search);
    return { body: { data: q.get('me') === '0' ? null : q.get('asAdmin') === '1' ? ME_ADMIN : ME } };
  }
  if (p.endsWith('/api/v1/site')) return { body: { data: SITE } };
  if (p.endsWith('/api/v1/boards')) return { body: { data: BOARDS } };
  if (p.includes('/api/v1/topics/tp-1/sources/')) return { status: 302 };
  if (p.endsWith('/api/v1/topics/tp-1')) return { body: { data: TOPIC_DETAIL } };
  if (p.endsWith('/api/v1/topics/tp-1/posts')) return { body: { data: POSTS, next_cursor: null } };
  if (p.endsWith('/api/v1/topics/tp-1/issues')) {
    const status = url.searchParams.get('status') ?? 'open';
    return { body: { data: ISSUES.filter((i) => i.status === status), next_cursor: null } };
  }
  if (p.endsWith('/api/v1/topics')) return { body: { data: TOPICS, next_cursor: null } };
  if (p.includes('/api/v1/issues/') && p.endsWith('/comments')) return { body: { data: ISSUE_COMMENTS, next_cursor: null } };
  if (p.includes('/api/v1/issue-comments/') && p.endsWith('/replies')) return { body: { data: [] } };
  if (p.includes('/api/v1/issue-comments/') && p.endsWith('/vote')) return { body: { data: { like_count: 1, dislike_count: 0, my_vote: method === 'DELETE' ? 0 : 1 } } };
  if (p.includes('/api/v1/issues/')) {
    const id = p.split('/api/v1/issues/')[1] ?? '';
    const row = ISSUES.find((i) => i.id === id);
    return row ? { body: { data: { ...row, body_html: '<p>按攻略在右上角废墟等事件，已经提前到 14:20 了还是没触发。</p>' } } } : undefined;
  }
  if (p.endsWith('/api/v1/issues')) return { body: { data: ISSUES.filter((i) => i.status === (url.searchParams.get('status') ?? 'open')), next_cursor: null } };
  if (p.endsWith('/api/v1/messages')) return { body: { data: [CONVERSATION], next_cursor: null } };
  if (p.includes('/api/v1/messages/') && p.endsWith('/read')) return { body: { data: { ok: true } } };
  if (p.includes('/api/v1/messages/')) return { body: { data: { ...THREAD, items: [...THREAD.items].reverse() }, next_cursor: null } };
  if (p.endsWith('/api/v1/messages/unread')) return { body: { data: { count: 1 } } };
  if (p.endsWith('/api/v1/notifications/unread')) return { body: { data: { count: 4 } } };
  if (p.endsWith('/api/v1/notifications/settings')) {
    return { body: { data: { alert: 'all', reply_scope: 'all', mention_scope: 'all', like_alert: 'all' } } };
  }
  if (p.endsWith('/api/v1/notifications')) {
    const kind = url.searchParams.get('kind') ?? 'reply';
    return { body: { data: NOTIFICATIONS[kind] ?? [], next_cursor: null } };
  }
  if (p.endsWith('/api/v1/search')) {
    return url.searchParams.get('type') === 'users'
      ? { body: { data: [USER('demo-admin', '示范管理员'), USER('demo-voidray', '虚空辉光舰')], next_cursor: null } }
      : { body: { data: TOPICS, next_cursor: null } };
  }
  // 收款码（L1）：形状照 media/dto.go 的 PaymentChannel（id / label / image / sort）。
  // 图还是坏图（预览服务没有 /img/*），但**形状是真的** —— 出图要看的是布局与文案，不是二维码像素。
  if (p.includes('/api/v1/users/') && p.endsWith('/channels')) {
    return { body: { data: [{ id: 'ch-1', label: '微信', image: '/img/preview-channel-1', sort: 0 }] } };
  }
  // 赞赏设置与我的申报（L1）：字段名照 reward/dto.go 的 DonationSettings / DonationPage。
  if (p.endsWith('/api/v1/me/donation-settings')) {
    return { body: { data: { show_channels: true, records_public: false, notice_visible: true, notice_text: '扫码后请在备注里写昵称，我好对上号。' } } };
  }
  if (p.endsWith('/api/v1/me/payment-channels')) {
    return { body: { data: [{ id: 'ch-1', label: '微信', image: '/img/preview-channel-1', sort: 0 }] } };
  }
  if (p.endsWith('/api/v1/me/rewards')) {
    return {
      body: {
        data: [
          { id: 'd-1', amount_cents: 1000, txn_id: '', state: 'pending', note: '', post_id: '', channel_id: 'ch-1', recipient: { handle: 'demo-admin', nickname: '示范管理员', avatar: '' }, created_at: '2026-10-14T02:00:00Z' },
        ],
        next_cursor: null,
      },
    };
  }
  if (p.includes('/api/v1/users/')) {
    return {
      body: {
        data: {
          ...USER('demo-admin', '示范管理员', { key: 'admin', name: '管理员' }),
          bio: '战役作者。',
          level: 27,
          exp: 640,
          exp_max: 1000,
          topic_count: 86,
          like_received: 12480,
          joined_at: '2024-03-02T00:00:00Z',
          title: null,
        },
      },
    };
  }
  return undefined;
}

/** ?stub=1（默认）时把 window.fetch 换掉；返回一个能看请求流水的东西，出图脚本用它诊断。 */
export function installFixture(): FixtureRequest[] {
  const log: FixtureRequest[] = [];
  const real = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    log.push({ url: u, method, body: init?.body });
    const hit = fixtureFor(u, method);
    if (!hit) return real(input as RequestInfo, init);
    // 转链端点：出图时不该真跳外站，给一个 302（页面自己不消费这个响应，只保证不发真请求）
    if (hit.status === 302) return new Response(null, { status: 302, headers: { location: 'about:blank' } });
    return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof window.fetch;
  return log;
}
