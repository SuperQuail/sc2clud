import { assetUrl } from '@/lib/url';
import type { UserSummary } from '@/ui/user/user-badge';

// 本页是设计验证页：数据是页面内的假数据（前端方案 §10.1 禁止用假数据绕过接口——这里不出现在产品路由里）。
// 字段名逐字照 完全重构/论坛后端技术方案-v2.md §21.3 的帖子列表响应：
//   id / board{slug,name} / kind / title / author{handle,nickname,avatar} / reply_count / like_count /
//   view_count / featured_at / pinned / created_at / last_reply_at / cover / viewer{liked,bookmarked}
// **excerpt 不在 §21.3 里**（契约缺口，已写进回报）——方卡片与紧凑列表都要它。
export type TopicKind = 'discussion' | 'resource' | 'repost';

export type Topic = {
  id: string;
  board: { slug: string; name: string };
  kind: TopicKind;
  title: string;
  /** 摘要：§21.3 没这个字段，见回报的「明确的后端需求变动」 */
  excerpt: string;
  author: UserSummary;
  reply_count: number;
  like_count: number;
  view_count: number;
  /** ISO UTC，与后端一致；展示时才格式化 */
  created_at: string;
  last_reply_at: string;
  cover?: string | null;
  pinned?: boolean;
  /** 契约里是 featured_at（ISO 或 null）；这里为了排版方便存了格式化好的文案 */
  featured_at?: string | null;
};

export type BoardFilter = { key: string; label: string; count: number };

const AV = {
  portrait: assetUrl('miyin-portrait-160.webp'),
  chibi: assetUrl('miyin-chibi-160.webp'),
  smile: assetUrl('miyin/smile-160.webp'),
  genius: assetUrl('miyin/genius-160.webp'),
  wink: assetUrl('miyin/wink-520.webp'),
};

// 作者一律取自 完全重构/DevRoom-假数据规范.md 的统一名单：DevRoom 公开部署（无鉴权），
// mock 会进 bundle —— 不许出现真实社区成员。里面故意留了长昵称（虚空辉光舰）与无头像的（走首字兜底），
// 用来验证「名字长了会不会把卡片撑破」。
const U = {
  admin: { handle: 'demo-admin', nickname: '示范管理员', avatar: AV.portrait },
  marine: { handle: 'demo-marine', nickname: '陆战队员', avatar: AV.chibi },
  zealot: { handle: 'demo-zealot', nickname: '狂热者', avatar: AV.smile },
  battlecruiser: { handle: 'demo-battlecruiser', nickname: '大和号', avatar: AV.genius },
  drone: { handle: 'demo-drone', nickname: '工蜂', avatar: AV.wink },
  voidray: { handle: 'demo-voidray', nickname: '虚空辉光舰', avatar: null },
} satisfies Record<string, UserSummary>;

// 封面素材（public/art 下真的存在且能解码的图）。只挑够大的：
// 卡片封面位是 256×144，小图（48/64px 的导航图标）在这里必然糊——那种情况改走占位块。
const COVERS = {
  battle: assetUrl('starcraft/sc2-battle.webp'),
  wink: assetUrl('miyin/wink-520.webp'),
  welcome: assetUrl('miyin/welcome-400.webp'),
  unavailable: assetUrl('miyin/image-unavailable-480.webp'),
  portrait: assetUrl('miyin-portrait-320.webp'),
};

// 时间戳由「距今多少分钟」**每次取用**时算出来（不是模块加载时算一次）：
// 服务端给的是固定 ISO 串，演示数据这样写才能让相对时间一直是真的。
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export const BOARDS: BoardFilter[] = [
  { key: 'all', label: '全部', count: 1286 },
  { key: 'campaign', label: '自制战役', count: 512 },
  { key: 'terrain', label: '地图与地形', count: 233 },
  { key: 'data', label: '数据与代码', count: 184 },
  { key: 'art', label: '美术与素材', count: 141 },
  { key: 'tool', label: '工具与插件', count: 96 },
  { key: 'help', label: '求助答疑', count: 120 },
];

// 分区筛选：这是**同一页的视图状态**，将来直接进 URL（?board=）——所以是 React 状态，不是命令式 DOM 操作
export const SORTS = [
  { key: 'latest', label: '最新回复' },
  { key: 'new', label: '最新发布' },
  { key: 'hot', label: '最热' },
] as const;
export type SortKey = (typeof SORTS)[number]['key'];

// 「全部」不筛选；点某个分区时按 board.slug 过滤（数据驱动，不是写死的 if 链）
export function filterByBoard(topics: Topic[], board: string): Topic[] {
  return board === 'all' ? topics : topics.filter((t) => t.board.slug === board);
}

export const TOPICS: Topic[] = [
  {
    id: '0192f0a1', board: { slug: 'campaign', name: '自制战役' }, kind: 'resource',
    title: '《余烬》第三章完整版发布：4 关战役 + 全语音 + 中英双语',
    excerpt: '三个月打磨的第三章今天上线。四关战役、9 段过场、全语音，安装包与更新说明都在帖子里。',
    author: U.admin, reply_count: 128, like_count: 96, view_count: 4203,
    created_at: ago(2880), last_reply_at: ago(3), cover: COVERS.battle, pinned: true, featured_at: '精华',
  },
  {
    id: '0192f0a2', board: { slug: 'terrain', name: '地图与地形' }, kind: 'discussion',
    title: '菌毯推进的手感是怎么调出来的？聊聊触发器与装饰物的配合',
    excerpt: '很多人问菌毯为什么看起来在「生长」而不是整片刷出来。核心是分块延迟 + 装饰物动画，不是特效。',
    author: U.marine, reply_count: 64, like_count: 51, view_count: 3310,
    created_at: ago(1440), last_reply_at: ago(26), cover: COVERS.wink,
  },
  {
    id: '0192f0a3', board: { slug: 'art', name: '美术与素材' }, kind: 'resource',
    title: '自制战役常用图标包 v3（重绘 128 个技能与单位图标）',
    excerpt: '统一描边、统一视角的一套图标，含 DDS 与 PNG 两种格式，附命名规范与授权说明。',
    author: U.battlecruiser, reply_count: 42, like_count: 77, view_count: 1180,
    created_at: ago(4320), last_reply_at: ago(95), cover: COVERS.welcome, featured_at: '精华',
  },
  {
    id: '0192f0a4', board: { slug: 'data', name: '数据与代码' }, kind: 'discussion',
    title: '触发器里做「动态难度」的三种写法，以及各自的性能代价',
    excerpt: '用周期事件轮询、用伤害事件回调、用自定义值缓存，实测在 200 单位规模下的帧率差别。',
    author: U.zealot, reply_count: 37, like_count: 29, view_count: 962,
    created_at: ago(600), last_reply_at: ago(140), cover: COVERS.portrait,
  },
  {
    id: '0192f0a5', board: { slug: 'help', name: '求助答疑' }, kind: 'discussion',
    title: '导入自定义模型后角色变成紫色方块，是贴图路径还是材质的问题？',
    excerpt: '模型能进编辑器、能放进地图，但一进游戏就是紫方块。已经确认贴图是 DDS 且路径没中文。',
    author: U.drone, reply_count: 18, like_count: 4, view_count: 420,
    created_at: ago(300), last_reply_at: ago(55), cover: null,
  },
  {
    id: '0192f0a6', board: { slug: 'campaign', name: '自制战役' }, kind: 'repost',
    title: '转载：国外作者 Kaldor 的「星海边境」第一章汉化版',
    excerpt: '已获得作者授权转载与汉化。文本量约 1.2 万字，欢迎校对，错别字直接回复即可。',
    author: U.voidray, reply_count: 23, like_count: 15, view_count: 640,
    created_at: ago(2000), last_reply_at: ago(210), cover: COVERS.unavailable,
  },
  {
    id: '0192f0a7', board: { slug: 'terrain', name: '地图与地形' }, kind: 'resource',
    title: '沙漠地形包：可复用的 12 个崖体组件与 3 套光照预设',
    excerpt: '按「崖体拼接」的思路做的组件，拖进地图就能连成连续山脊；光照预设直接开箱可用。',
    author: U.marine, reply_count: 31, like_count: 44, view_count: 890,
    created_at: ago(5200), last_reply_at: ago(300), cover: COVERS.wink,
  },
  {
    id: '0192f0a8', board: { slug: 'tool', name: '工具与插件' }, kind: 'resource',
    title: '汉化补丁生成器 0.9：从 GameStrings 自动产出对照表',
    excerpt: '扫描地图内的 GameStrings.txt，生成可直接翻译的对照表并回填；支持增量更新。',
    author: U.zealot, reply_count: 12, like_count: 33, view_count: 512,
    created_at: ago(700), last_reply_at: ago(420), cover: COVERS.welcome,
  },
  {
    id: '0192f0a9', board: { slug: 'data', name: '数据与代码' }, kind: 'discussion',
    title: '同一张地图里同时存在合作指挥官与战役科技，会不会互相污染？',
    excerpt: '实验结论：需要给两套数据各自独立的目录与升级项，否则玩家的科技状态会串到另一套里。',
    author: U.battlecruiser, reply_count: 26, like_count: 19, view_count: 733,
    created_at: ago(2600), last_reply_at: ago(500), cover: null,
  },
  {
    id: '0192f0aa', board: { slug: 'art', name: '美术与素材' }, kind: 'discussion',
    title: '战役过场里的镜头语言：三种便宜又有效的做法',
    excerpt: '不做电影化渲染也能有叙事感：用镜头推近、用单位朝向引导视线、用环境音过渡。',
    author: U.admin, reply_count: 48, like_count: 62, view_count: 1520,
    created_at: ago(3800), last_reply_at: ago(660), cover: COVERS.battle,
  },
  {
    id: '0192f0ab', board: { slug: 'help', name: '求助答疑' }, kind: 'discussion',
    title: '银行存档在多人模式下不同步，有排查思路吗？',
    excerpt: '本地单机存档正常，一进多人房间进度就各存各的。已排除版本不一致的可能。',
    author: U.drone, reply_count: 9, like_count: 2, view_count: 288,
    created_at: ago(120), last_reply_at: ago(40), cover: null,
  },
  {
    id: '0192f0ac', board: { slug: 'campaign', name: '自制战役' }, kind: 'repost',
    title: '转载：老站「自制战役索引帖」里的 30 张经典地图链接整理',
    excerpt: '把老索引帖里还能下载的地图重新核对了一遍，失效链接已标注替代地址。',
    author: U.voidray, reply_count: 15, like_count: 21, view_count: 476,
    created_at: ago(9000), last_reply_at: ago(1200), cover: COVERS.unavailable,
  },
];