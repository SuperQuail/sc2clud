import { adminFixtureFor, COVER_HASH, ME_ADMIN } from './admin-fixtures';
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

// 分区（左栏那一行的计数就来自它）：字段名照 BoardDTO。
// **计数不能是 0** —— 出图时左栏「0 帖子」与右栏「12 帖子」并排出现，一眼就看得出桩是坏的。
//
// cover_hash 用的是**真实导入的**五个分区图标（完全重构/迁移素材/board-covers.json 的 sha256，
// 由 forum board-covers 写进 boards.cover_hash）。MIG-ART 2026-10-14 改：原来这里是 `cover: null` ——
// 字段名根本不存在于 BoardDTO（真名是 cover_hash，forum/dto.go:43），于是产品预览左栏永远是首字占位，
// 「有封面时真的画图」那条分支在出图里一次都没出现过。
const COVER = (hash: string) => ({ cover_hash: hash });
const BOARD = { slug: 'custom-campaign', name: '自制战役', description: '玩家自制战役与地图。', ...COVER('509bb743ef85b654fc1b7efe2e8019e32757eac72bfe38077f9efc5bf5712c80'), topic_count: 12, post_count: 130, today_count: 1 };
/** 关注状态（follow.State 逐字形状）：值就地改，PUT/DELETE 之后那张图才看得出「已关注」。 */
const FOLLOW = { target: 'board', slug: 'custom-campaign', following: false, follower_count: 128 };
const BOARDS = [
  { slug: 'announcement', name: '公告', description: '站点公告与版本发布。', ...COVER('e70ef0760eb4de0bc8ef07e13cb49d720d3d9ade4457911d582013d753392e9d'), topic_count: 6, post_count: 41, today_count: 1 },
  BOARD,
  { slug: 'vanilla-mod', name: '原版战役 mod', description: '不改剧情、只改体验。', ...COVER('3e585f10269d74597977cd559d954dcb2bf325e0fdeecb104fc3d22e714fcd25'), topic_count: 5, post_count: 33, today_count: 0 },
  { slug: 'tool-player', name: '工具（玩家）', description: '给玩家用的工具。', ...COVER('fd1a41d9fb359eebdfb7ecde7be05c73ea7f85655b14e9acd7ec4c55b478a1b8'), topic_count: 9, post_count: 74, today_count: 1 },
  { slug: 'tool-dev', name: '工具（开发者）', description: '编辑器、触发器、数据表。', ...COVER('70162fcf4099dbcf103063ac5845b1692fd580e579b1f6e194bdfe7594a836cf'), topic_count: 23, post_count: 180, today_count: 3 },
  { slug: 'emperor', name: '皇帝区', description: '需要权限的分区。', ...COVER(''), topic_count: 3, post_count: 12, today_count: 0 },
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

// 正文真源（Lexical EditorState 的 JSON，就是后端 content_md 那一列）：编辑弹层把它灌回
// MarkdownEditor。**不能是 null** —— 那会拍到一个空编辑器，看不出「初值真的灌进去了」。
// 这是后端存的那种形状（root → paragraph → text），不是手写的另一套。
const TOPIC_MD = JSON.stringify({
  root: {
    children: [
      '第三章「余烬」已经发布。这一版主要做三件事：隐藏结局线、菌毯铺速回调、以及读档后事件计时改为任务时间。',
      '下载与提取码见右侧来源区；遇到问题请点下面的反馈入口。',
    ].map((text) => ({
      children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'paragraph',
      version: 1,
    })),
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
});

const TOPIC_DETAIL = {
  ...TOPICS[0],
  content_md: TOPIC_MD,
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
  // 这三个字段会被 topicDetail() 覆盖（演「保存 → 打回 pending」与「打回修改」两态），
  // 所以基准值在这里**显式放宽**：不收窄的话展开出的对象与基准不是同一个类型（TS2322）。
  review_state: 'approved' as string,
  review_note: null as string | null,
  revision_of: undefined as { content_md: string; content_html: string; approved_at: string } | undefined,
  issue_open_count: 2,
  can_reply: true,
  // can_edit 照**作者视角**给：L7 的出图要真的走一遍「编辑 → 保存 → 打回 pending」，
  // 而「能不能编辑」后端是靠这个字段说的（路由用 wire.can_edit ?? 权限兜底）。
  can_edit: true,
};

/**
 * 出图脚本会真的保存一次（L7 那条要演「保存 → 服务端打回 pending」），所以桩必须是**可写**的。
 * 写在哪很关键：不能写模块变量 —— 同一个 Chrome 实例里每一张图都是**新标签页、共用同一份模块**，
 * 于是「先拍的那张把状态改了，后拍的那张就不是初始态」；也不能写 localStorage（跨标签页共享，同样串味）。
 * **sessionStorage 是按标签页隔离的**，正好等于「每张图各一份」。
 */
const SAVED_KEY = 'preview-topic-tp-1-saved';

type SavedTopic = { title?: string; content_md?: string };

function savedTopic(): SavedTopic {
  try {
    return JSON.parse(sessionStorage.getItem(SAVED_KEY) ?? '{}') as SavedTopic;
  } catch {
    return {};
  }
}

/**
 * 桩的当前值 = 基准 + 本标签页存过的那一次保存 + 出图用的 `?review=` 覆盖。
 * `?review=revision_requested` 演 L6 的第四态（打回修改）：后端那时会一并给出 `revision_of`
 * ——「最后一个过审版本」（拍板 §L6：原始版本已过审时显示它）。
 */
function topicDetail(): typeof TOPIC_DETAIL {
  const saved = savedTopic();
  const review = new URLSearchParams(location.search).get('review');
  return {
    ...TOPIC_DETAIL,
    ...(saved.title ? { title: saved.title } : {}),
    ...(saved.content_md ? { content_html: '<p>' + saved.content_md + '</p>' } : {}),
    // 保存过正文 = 后端把审核态打回了 pending（forum 的 ResetTopicReview，597c4ac）
    ...(saved.content_md ? { review_state: 'pending', review_note: null } : {}),
    // 「已转人工」（拍板 08 §第三轮 6）：后端按 review_events 最新一条判定给这个字段
    ...(review === 'pending_human' && !saved.content_md ? { review_state: 'pending', review_pending_human: true } : {}),
    ...(review === 'revision_requested' && !saved.content_md
      ? {
          review_state: 'revision_requested',
          review_note: '第 3 段引用的来源没有标注出处，请补上原始出处后再提交。',
          revision_of: {
            content_md: '上一版的正文',
            content_html: '<p>这是上一次过审时的正文：隐藏结局在 15:00 前到废墟触发，读档后事件计时按任务时间算。</p>',
            approved_at: '2026-10-13T02:00:00Z',
          },
        }
      : {}),
  };
}

/** 第二个帖子详情：**只给出图用的第二态** —— 作者刚保存过、服务端把审核态打回了 pending（L7 的横幅）。
 *  真站的 pending 只有作者本人拿得到（后端过滤），桩照这个口径给。 */
const TOPIC_RESUBMITTED = { ...TOPIC_DETAIL, id: 'tp-2', review_state: 'pending', review_note: null, can_edit: true };

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

/** 一条请求 → 一条响应；undefined = 不拦（交回真实的 fetch）。顺序敏感：具体路径写在前面。
 *  body 只有写请求才有（出图脚本要演「保存 = 重新提交审核」那条链路，见下面的 PATCH tp-1）。 */
export function fixtureFor(u: string, method: string, body?: unknown): Reply | undefined {
  const url = new URL(u, 'http://stub');
  const p = url.pathname;
  // L7 出图：作者保存正文 → 后端把 review_state 打回 pending（forum 的 ResetTopicReview）。
  // 桩要**跟着变**，否则拍到的还是「已通过」那一屏，等于没验。
  if (method === 'PATCH' && p.endsWith('/api/v1/topics/tp-1')) {
    sessionStorage.setItem(SAVED_KEY, JSON.stringify((body ?? {}) as SavedTopic));
    return { body: { data: topicDetail() } };
  }
  // 管理后台（/admin/*）：自己的桩，具体路径写在那一份里
  const admin = adminFixtureFor(u);
  if (admin !== undefined) return admin;
  // 游客态：?me=0（真后端「没登录」也是 200 + data:null，不是报错）
  // ?asAdmin=1 换成管理员身份：后台每一屏都要 perms，而这里的默认身份是普通成员。
  if (p.endsWith('/api/v1/me')) {
    const q = new URLSearchParams(location.search);
    const me = q.get('me');
    // ?me=author 用**帖子作者**身份（L7 的出图要走「作者改自己的帖子」：
    // can_edit 是后端按作者算的，认错人就没有「编辑」按钮）
    return { body: { data: me === '0' ? null : me === 'author' ? { ...ME, handle: 'demo-admin', nickname: '示范管理员' } : q.get('asAdmin') === '1' ? ME_ADMIN : ME } };
  }
  if (p.endsWith('/api/v1/site')) return { body: { data: SITE } };
  if (p.endsWith('/api/v1/boards')) return { body: { data: BOARDS } };
  // 关注分区（拍板 08 §第三轮 1+2）：那一格「成员」与那颗「关注分区」按钮的真源。
  // 数字必须是**真数**（不是 0）—— 出图要看的正是「它不再是恒 0」。
  if (p.includes('/api/v1/boards/') && p.endsWith('/follow')) {
    const on = method === 'PUT' ? true : method === 'DELETE' ? false : FOLLOW.following;
    FOLLOW.following = on;
    FOLLOW.follower_count += method === 'PUT' ? 1 : method === 'DELETE' ? -1 : 0;
    return { body: { data: { ...FOLLOW } } };
  }
  if (p.includes('/api/v1/topics/tp-1/sources/')) return { status: 302 };
  if (p.endsWith('/api/v1/topics/tp-1')) return { body: { data: topicDetail() } };
  if (p.endsWith('/api/v1/topics/tp-2')) return { body: { data: TOPIC_RESUBMITTED } };
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
    // 用户档的条目是 **user.SearchItem**（不是 UserBriefDTO）：id 是**数字 user id**
    // （它要直接填进提及的 `mention:<id>`），另有 level 与 ambiguous（重名标记）。
    // 这两条差别必须在这里照抄 —— 少了 id/handle，@提及候选插进正文的就是一个渲染不出来的提及。
    return url.searchParams.get('type') === 'users'
      ? {
          body: {
            data: [
              { id: 12, handle: 'demo-admin', nickname: '示范管理员', avatar: null, level: 12, ambiguous: false },
              { id: 44, handle: 'demo-voidray', nickname: '虚空辉光舰', avatar: null, level: 3, ambiguous: false },
            ],
            next_cursor: null,
          },
        }
      : { body: { data: TOPICS, next_cursor: null } };
  }
  // 收款码（L1）：形状照 media/dto.go 的 PaymentChannel（id / label / image / sort）。
  // 图还是坏图（预览服务没有 /img/*），但**形状是真的** —— 出图要看的是布局与文案，不是二维码像素。
  // 个人主页的帖子列表：端点 /users/{handle}/topics 回的是 **TopicCardDTO**（含 author）。
  // 少了 author 这一条，个人主页会当场 TypeError（toCardTopic 读 t.author.avatar_hash）——
  // 2026-10-14 出图时真撞上过，页面变成一张「出错」错误页。桩的形状必须与 DTO 一样全。
  if (p.includes('/api/v1/users/') && p.endsWith('/topics')) return { body: { data: TOPICS, next_cursor: null } };
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
          // 个人主页封面（0030）：桩数据里设一张，出图才看得见「更换封面 + 清空封面」两态
          cover: '/img/' + COVER_HASH,
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
    // body 可能是 JSON，也可能是 FormData（头像上传）——只有 JSON 才解，解不开就当没有
    let sent: unknown;
    if (typeof init?.body === 'string') {
      try {
        sent = JSON.parse(init.body);
      } catch {
        sent = undefined;
      }
    }
    const hit = fixtureFor(u, method, sent);
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
