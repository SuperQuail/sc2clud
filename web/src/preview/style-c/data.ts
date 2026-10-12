// 方向 C · 贴吧血统：分区页的假数据与共享类型。
// 字段名与形状照抄 完全重构/设计需求-分区页.md §D / 后端方案 §21.3（真实数据走 /api/v1/boards 与 /api/v1/topics）。
// 预览不连网：这四行 import 就是全部「数据源」，接真接口时整块换成 TanStack Query。
import coverBoard from './cover-board.svg';
import coverCampaign from './cover-campaign.svg';
import coverMap from './cover-map.svg';
import coverTool from './cover-tool.svg';

export type Kind = 'discussion' | 'resource' | 'repost';
export type Author = { handle: string; nickname: string; avatar: string };
export type Board = {
  slug: string; name: string; description: string; cover: string;
  topic_count: number; post_count: number; member_count: number; today_count: number; joined: boolean;
};
export type Topic = {
  id: string; title: string; excerpt: string; kind: Kind; author: Author;
  reply_count: number; like_count: number; view_count: number;
  last_reply_at: string; created_at: string; cover?: string; pinned?: boolean; featured?: boolean;
};
export type BoardTab = 'all' | 'featured' | 'resource' | 'discussion' | 'repost' | 'news';

// 图是标签，不是字符串：TS 不会把 string 收窄成 keyof typeof，这里转一次省掉满页 as
export const BOARD_SLUGS = ['campaign', 'map', 'trigger', 'art', 'tool', 'help', 'news'] as const;

export type BoardSlug = (typeof BOARD_SLUGS)[number];

const RAW_BOARDS: Record<BoardSlug, [string, string, number, number, number, number, boolean]> = {
  campaign: ['自制战役', '单机战役的地图、脚本、过场与发布', 412, 5820, 3180, 9, true],
  map: ['地图开发', '对战与合作的布局、地形、平衡性讨论', 236, 3140, 1620, 4, true],
  trigger: ['触发器与数据', 'GUI 触发器、自定义脚本与数据编辑器', 301, 4402, 1980, 7, false],
  art: ['模型与美术', '模型导入、贴图、特效与场景光照', 118, 1266, 940, 2, false],
  tool: ['工具与插件', '地图编辑器插件、外部工具与流水线', 97, 1103, 760, 1, false],
  help: ['提问求助', '卡住了就发这里，附上最小复现', 208, 2974, 2140, 12, false],
  news: ['公告', '站点规则、版本更新与活动', 12, 486, 4210, 0, true],
};

export const BOARDS: Record<string, Board> = Object.fromEntries(
  Object.entries(RAW_BOARDS).map(([slug, r]) => [
    slug,
    {
      slug, name: r[0], description: r[1], cover: coverBoard,
      topic_count: r[2], post_count: r[3], member_count: r[4], today_count: r[5], joined: r[6],
    } satisfies Board,
  ]),
);

const AUTHORS = {
  tang: { handle: 'tangtian', nickname: '唐天', avatar: coverCampaign },
  lin: { handle: 'linq', nickname: '林奇', avatar: coverTool },
  an: { handle: 'anan', nickname: '阿南', avatar: coverMap },
  yue: { handle: 'yueying', nickname: '月影', avatar: '' },
  mo: { handle: 'moxi', nickname: '墨汐', avatar: '' },
  ke: { handle: 'kexue', nickname: '柯雪', avatar: '' },
  zhou: { handle: 'zhouyu', nickname: '周瑜', avatar: '' },
} satisfies Record<string, Author>;

type Draft = {
  b: BoardSlug; k: Kind; t: string; e: string; a: keyof typeof AUTHORS;
  r: number; l: number; v: number; ago: number; born: number; cover?: string; pin?: boolean; feat?: boolean;
};

// ago / born 是「几分钟前」，运行时再算成 ISO：假数据不会随时间变旧，看图始终有新鲜时间
const DRAFTS: Draft[] = [
  { b: 'campaign', k: 'resource', t: '《艾尔的余烬》第三章发布：18 张地图 + 全新单位线', e: '主线 6 张、支线 12 张，含 3 个可选结局；附完整汉化与存档兼容补丁。', a: 'tang', r: 326, l: 148, v: 12480, ago: 7, born: 4320, cover: coverCampaign, pin: true },
  { b: 'news', k: 'discussion', t: '关于资源帖审核与转载授权的规则（2026 修订）', e: '转载必须标明原作者与原始链接；未授权的搬运一律下架，申诉走举报入口。', a: 'tang', r: 42, l: 96, v: 5210, ago: 51, born: 20000, pin: true },
  { b: 'trigger', k: 'resource', t: '触发器模板库 v2：37 个可直接拖进地图的 AI 波次模块', e: '按难度分档，每个模块自带注释与依赖说明，复制进地图即可跑。', a: 'lin', r: 88, l: 61, v: 4302, ago: 96, born: 9000, cover: coverTool, feat: true },
  { b: 'trigger', k: 'discussion', t: '数据编辑器里给单位加自定义武器，为什么射程永远按默认值走？', e: '改的是武器本身而不是单位上的引用，怀疑是继承链没断干净，求一个排查顺序。', a: 'yue', r: 24, l: 9, v: 1502, ago: 132, born: 700 },
  { b: 'art', k: 'resource', t: '战役地图亮度与雾效预设包（11 个预置，含沙漠与虚空夜）', e: '直接覆盖到 Maps 目录，附对比图；沙漠那套建议把后处理关掉。', a: 'an', r: 57, l: 44, v: 3390, ago: 188, born: 6000, cover: coverMap, feat: true },
  { b: 'news', k: 'repost', t: '[转载] 官方 Mod 工具链 2026 路线图要点翻译', e: '原文在官方论坛，这里只翻译与地图作者相关的部分，附术语对照表。', a: 'mo', r: 33, l: 27, v: 2860, ago: 240, born: 1200 },
  { b: 'campaign', k: 'discussion', t: '一人做战役的排期经验：把美术外包和脚本拆开之后', e: '拆开之后返工少了一半，但接口要对齐；这是我用的任务表与验收清单。', a: 'ke', r: 71, l: 52, v: 4108, ago: 305, born: 8800 },
  { b: 'tool', k: 'resource', t: '自制战役启动器 1.7.2：支持多存档槽与自动更新校验', e: '签名校验失败会直接拒绝启动；旧存档需要先用 1.6 的迁移工具过一遍。', a: 'zhou', r: 46, l: 38, v: 3612, ago: 366, born: 4400, cover: coverTool },
  { b: 'art', k: 'discussion', t: 'Blender 导出 m3 之后贴图全黑，是哪一步漏了？', e: '材质是 Principled，导出时没有勾选嵌入贴图，还是路径大小写的问题？', a: 'an', r: 19, l: 6, v: 990, ago: 420, born: 300 },
  { b: 'art', k: 'resource', t: '中文语音包（男声 / 女声）与字幕对齐脚本', e: '44.1kHz 单声道，脚本按触发器文件自动切句，附对齐失败的排查方法。', a: 'yue', r: 63, l: 49, v: 5230, ago: 512, born: 11000, cover: coverCampaign, feat: true },
  { b: 'tool', k: 'repost', t: '[转载] 韩国社区的自定义 UI 框架，附中文注释补丁', e: '框架本身是 MIT，补丁只翻译注释；字体需要自行替换成中文可用字体。', a: 'lin', r: 12, l: 8, v: 1180, ago: 640, born: 900 },
  { b: 'map', k: 'discussion', t: '地图里 40 个单位以上就掉帧，有哪些低成本的优化手段？', e: '已经试过关掉装饰物与阴影；想知道寻路与触发器哪个更值得先动。', a: 'ke', r: 85, l: 31, v: 4720, ago: 700, born: 5200 },
  { b: 'map', k: 'resource', t: '地形笔刷与装饰物包：雪原 / 熔岩 / 都市三套', e: '每套 30 个装饰物，已按风格分好目录，直接拖进依赖即可使用。', a: 'mo', r: 28, l: 22, v: 2110, ago: 823, born: 3300, cover: coverMap },
  { b: 'trigger', k: 'discussion', t: '触发器里做存档兼容：老存档读新地图会不会直接崩？', e: '实测改结构体字段名会丢数据但不会崩；想确认版本字段该怎么设计。', a: 'zhou', r: 37, l: 14, v: 1860, ago: 940, born: 2600 },
  { b: 'campaign', k: 'resource', t: '战役过场动画模板：运镜 + 字幕 + 跳过逻辑都接好了', e: '含 6 段示例运镜，跳过逻辑尊重玩家设置；字幕时间轴用秒表对齐。', a: 'tang', r: 54, l: 40, v: 3044, ago: 1080, born: 6600, cover: coverCampaign },
  { b: 'help', k: 'discussion', t: '提问：多人合作地图怎么做掉线重连？', e: '官方的重连是自动的，但自定义存档里状态没同步，回来就错位。', a: 'yue', r: 16, l: 5, v: 780, ago: 1260, born: 400 },
  { b: 'help', k: 'discussion', t: '导入外部的 mp3 之后没有声音，是采样率还是通道数的问题？', e: '同一段音频转成 ogg 就正常了，想知道引擎对 mp3 的具体限制。', a: 'mo', r: 9, l: 2, v: 512, ago: 1500, born: 260 },
  { b: 'map', k: 'discussion', t: '关于新增「合作任务」子分区，先收集一下大家想看到的内容', e: '是补充官方任务的改动版，还是完全原创的合作图？投票在二楼。', a: 'ke', r: 64, l: 35, v: 2908, ago: 1680, born: 7400 },
];

const minsAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

export const TOPICS: Topic[] = DRAFTS.map((d, i) => ({
  id: '0192f0' + (100000 + i).toString(16) + 'a4',
  title: d.t,
  excerpt: d.e,
  kind: d.k,
  author: AUTHORS[d.a],
  reply_count: d.r,
  like_count: d.l,
  view_count: d.v,
  last_reply_at: minsAgo(d.ago),
  created_at: minsAgo(d.born),
  ...(d.cover === undefined ? {} : { cover: d.cover }),
  pinned: d.pin === true,
  featured: d.feat === true,
}));

export const BOARD_LIST: Board[] = BOARD_SLUGS.map((s) => BOARDS[s]).filter((b): b is Board => b !== undefined);

// 游标分页的分页器：两页就到底（预览要看得到「没有更多」的文案）
export const PAGE_SIZE = 14;
export const PAGE_1 = TOPICS.slice(0, PAGE_SIZE);
export const PAGE_2 = TOPICS.slice(PAGE_SIZE);
export const CURSOR_1 = 'eyJrIjoxNzYwMjQsImlkIjoiMDE5MmYwMTg2YTRhNCJ9';

export const TABS: { key: BoardTab; label: string; kind?: Kind; featured?: boolean }[] = [
  { key: 'all', label: '全部' },
  { key: 'featured', label: '精华', featured: true },
  { key: 'resource', label: '资源', kind: 'resource' },
  { key: 'discussion', label: '讨论', kind: 'discussion' },
  { key: 'repost', label: '转载', kind: 'repost' },
  { key: 'news', label: '公告' },
];

export const SORTS: { key: 'last_reply' | 'new' | 'hot' | 'essence'; label: string }[] = [
  { key: 'last_reply', label: '最新回复' },
  { key: 'new', label: '最新发布' },
  { key: 'hot', label: '最热' },
  { key: 'essence', label: '精华' },
];

export const KIND_LABEL: Record<Kind, string> = { discussion: '讨论', resource: '资源', repost: '转载' };

// 列表按分区标签过滤；置顶的永远在最前（贴吧规则）
export function filterTopics(board: Board, tab: BoardTab): Topic[] {
  const spec = TABS.find((x) => x.key === tab);
  let list = TOPICS.filter((t) => (board.slug === 'news' ? t.kind === 'repost' || t.pinned === true : true));
  if (tab === 'featured') list = list.filter((t) => t.featured === true || t.pinned === true);
  else if (tab === 'news') list = list.filter((t) => t.pinned === true);
  else if (spec?.kind !== undefined) list = list.filter((t) => t.kind === spec.kind);
  return [...list].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true));
}

export const BOARD_STATS = (b: Board): { label: string; value: string }[] => [
  { label: '主题', value: fmt(b.topic_count) },
  { label: '回复', value: fmt(b.post_count) },
  { label: '今日新帖', value: fmt(b.today_count) },
  { label: '关注', value: fmt(b.member_count) },
];

export function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  return (n / 10000).toFixed(1) + '万';
}

export const topicHref = (id: string): string => '#/t/' + id;
export const boardHref = (slug: string): string => '#/b/' + slug;
