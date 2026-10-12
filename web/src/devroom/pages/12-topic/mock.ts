import { assetUrl } from '@/lib/url';
import type { CommentData } from '@/ui/comment/types';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import type { Board, BoardNav, TopicPageData } from './types';

// 12-topic 的假数据。**只在本目录里**（业务页接的是 lib/api，不是这份）。
// 版块顺序与图标照产品导航：公告 / 原版战役 mod / 自制战役 / 工具（玩家）/ 工具（开发者）。

const A = (p: string) => assetUrl(p);

export const BOARDS: Board[] = [
  {
    slug: 'announcement',
    name: '公告',
    cover: A('starcraft/nav-announcement.webp'),
    description: '版本发布、维护窗口与规则变动只在这里发；讨论请到对应分区。',
    topic_count: 86,
    post_count: 1240,
    member_count: 5820,
    today_count: 2,
    joined: true,
    hint: '官方发布与维护公告',
  },
  {
    slug: 'vanilla-mod',
    name: '原版战役 mod',
    cover: A('starcraft/nav-vanilla_mod.webp'),
    description: '不改剧情、只改体验：平衡、AI、画面与手感。',
    topic_count: 412,
    post_count: 6120,
    member_count: 4310,
    today_count: 9,
    joined: true,
    hint: '原版战役的体验增强',
  },
  {
    slug: 'custom-campaign',
    name: '自制战役',
    cover: A('starcraft/nav-custom_campaign.webp'),
    description: '玩家自制战役与地图：发布、试玩反馈、卡关求助都在这里。',
    topic_count: 1284,
    post_count: 18430,
    member_count: 12460,
    today_count: 26,
    joined: true,
    hint: '自制战役与地图',
  },
  {
    slug: 'tool-player',
    name: '工具（玩家）',
    cover: A('starcraft/nav-tool_player.webp'),
    description: '给玩家用的工具：启动器、存档管理、汉化与画质补丁。',
    topic_count: 236,
    post_count: 3110,
    member_count: 2740,
    today_count: 7,
    joined: true,
    hint: '玩家向工具与补丁',
  },
  {
    slug: 'tool-dev',
    name: '工具（开发者）',
    cover: A('starcraft/nav-tool_dev.webp'),
    description: '给作者用的工具：数据编辑器辅助、脚本库、打包与发布流水线。',
    topic_count: 168,
    post_count: 2240,
    member_count: 1180,
    today_count: 4,
    joined: false,
    hint: '作者向工具与脚本库',
  },
];

/** 分区内导航：URL 上是 ?filter=all|featured|resource|discussion|announcement */
export const BOARD_NAV: BoardNav[] = [
  { key: 'all', label: '全部', count: 1284 },
  { key: 'featured', label: '精华', count: 147 },
  { key: 'resource', label: '资源', count: 862 },
  { key: 'discussion', label: '讨论', count: 341 },
  { key: 'announcement', label: '公告', count: 34 },
];

const TANG = {
  handle: 'tangtian',
  nickname: '唐天',
  avatar: A('miyin-portrait-320.webp'),
  role: { key: 'admin', name: '管理员' },
  title: { name: '执政官', color: '#2563eb' },
};

/** 当前登录者（GET /api/v1/me 的最小一份）：评论框与「我的」标记用 */
export const MY_ACCOUNT = { nickname: '林诗', avatar: A('miyin-chibi-160.webp') };

export const CANDIDATES: MentionCandidate[] = [
  { id: '12', nickname: '唐天', handle: 'tangtian', avatar: TANG.avatar, role: { key: 'admin', name: '管理员' } },
  { id: '37', nickname: '林诗', handle: 'linshi', avatar: MY_ACCOUNT.avatar, role: { key: 'creator', name: '认证创作者' } },
  { id: '58', nickname: '某小X', handle: 'xiaox' },
  { id: '91', nickname: '唐天（同名）', handle: 'tangtian2', duplicate: true },
];

export const AUTHOR = {
  ...TANG,
  bio: '战役作者，负责关卡设计与剧情。卡住、崩溃这类问题走反馈区，回复区只聊设计。',
  level: 27,
  exp: 640,
  exp_max: 1000,
  topic_count: 86,
  like_received: 12480,
  joined_at: '2024 年 3 月',
};

/** 正文富文本：后端 content_html 的样子（外链、@提及、列表、引用、代码、折叠长段落都有） */
export function topicBody(appPath: (p: string) => string): string {
  return [
    '<h2>这次改了什么</h2>',
    '<p>第 11 关（菌毯推进那关）的菌毯扩散速度原来跟着游戏速度走，8 分钟之后是几何级增长，',
    '正面硬顶基本打不过。现在改成<strong>线性推进 + 上限封顶</strong>，前 6 分钟与旧版一致，之后每 30 秒 +2%，最多 +40%。</p>',
    '<h3>数值对照</h3>',
    '<ul>',
    '<li>0–6 分钟：与旧版完全一致（老存档的节奏不会突然变快）</li>',
    '<li>6–18 分钟：每 30 秒 +2%，累计到 +40% 封顶</li>',
    '<li>18 分钟之后：不再增长（旧版此时约为 +260%）</li>',
    '</ul>',
    '<blockquote><p>结论：中期不再是一道必须靠 SL 过的墙，但漏防依然会输——只是输得有解释。</p></blockquote>',
    '<h3>怎么装</h3>',
    '<p>解压后把 <code>Maps</code> 整个目录覆盖到 StarCraft II 的安装目录即可；装过第二章的直接进游戏，存档兼容。</p>',
    '<p>第 4 关的护送目标不能离你太远，超过两屏它会自己往回走——这是引擎行为，这次没改。',
    '@<a href="' + appPath('u/12') + '" data-mention="12">唐天</a> 之前提过想改成 3 屏，我看影响面太大先搁置，有意见去 ',
    '<a href="' + appPath('?page=13-issue') + '">反馈区</a> 提。</p>',
    '<p>另外，进游戏前记得关掉别的战役 mod 的自动更新，不然中途被换掉版本会出现奇怪的寻路卡顿。</p>',
  ].join('');
}

export function topicComments(appPath: (p: string) => string): CommentData[] {
  const REPLY_TO_TANG: CommentData = {
    id: 'r1',
    author: { handle: 'xiaox', nickname: '某小X' },
    body: '18 分钟才封顶是不是太晚了？我把主基地的防空全给打光了才顶住第一波。<a href="' + appPath('u/12') + '" data-mention="12">@唐天</a>',
    createdAt: '2 小时前',
    likes: 6,
    dislikes: 0,
  };
  return [
    {
      id: 'c1',
      author: { handle: 'linshi', nickname: '林诗', avatar: MY_ACCOUNT.avatar, role: { key: 'creator', name: '认证创作者' } },
      body: '改完的通了一遍，第 11 关终于不用背时间轴了。旧版是 6 分钟一到就必须把两队兵往左下角塞，现在有余量去开分矿。',
      createdAt: '3 小时前',
      likes: 42,
      dislikes: 1,
      liked: true,
      replies: {
        total: 3,
        previewCount: 2,
        items: [
          REPLY_TO_TANG,
          {
            id: 'r2',
            author: TANG,
            body: '封顶时间我试过 14 分钟，背板的人会觉得没挑战；18 分钟是取了中间值。真要更早的话可以自己在触发器里改常量，反馈区里有说明。',
            createdAt: '1 小时前',
            likes: 11,
            dislikes: 0,
            op: true,
            mutual: true,
          },
        ],
      },
    },
    {
      id: 'c2',
      author: TANG,
      body: '补充一句：<strong>老存档</strong>在更新后重新进关卡就能生效，不需要重开战役。',
      createdAt: '5 小时前',
      likes: 88,
      dislikes: 2,
      op: true,
    },
    {
      id: 'c3',
      author: { handle: 'newcomer', nickname: '新来的' },
      body: [
        '<p>第一次通这关，说几个真会卡住人的地方：</p>',
        '<p>① 前 6 分钟别急着推，先把右下那个高能瓦斯占了，中期会非常缺气。</p>',
        '<p>② 工程车至少留两个在家补防空，AI 会绕后打补给站，正面赢着赢着家就没了。</p>',
        '<p>③ 18 分钟之后虽然不加速了，但 AI 的成队规模还在涨，别因为「封顶了」就把防线撤了去进攻。</p>',
        '<p>这三点踩完基本就稳了，剩下是操作问题。</p>',
      ].join(''),
      createdAt: '昨天 21:40',
      likes: 15,
      dislikes: 0,
    },
  ];
}

/** 收款码：真实值是 /img/<hash>；这里是页面内画的假二维码（见 payment-channel.tsx） */
export const CHANNELS: TopicPageData['channels'] = [
  { id: 'ch1', qr_url: 'mock://alipay', label: '支付宝', notice: '打赏是纯自愿的，不影响任何资源的更新节奏与下载权限。' },
  { id: 'ch2', qr_url: 'mock://wechat', label: '微信', notice: '打赏后请点「我已完成打赏」登记，我在后台人工核对。' },
];