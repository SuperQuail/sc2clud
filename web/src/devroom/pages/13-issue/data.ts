import type { MentionCandidate } from '@/ui/comment/mention-types';
import type { UserSummary } from '@/ui/user/user-badge';
import type { IssueComment, IssueDetail } from './types';

// 页面内 mock 数据（设计验证页：不 fetch、不接 api client）。
// 时间锚点固定，避免「刚刚」这类随运行时间漂移的文案影响看图。

const T = (daysAgo: number, hours = 0): string =>
  new Date(Date.UTC(2026, 9, 12, 12, 0, 0) - daysAgo * 86400_000 - hours * 3600_000).toISOString();

export const TANG = {
  handle: 'tangtian',
  nickname: '唐天',
  role: { key: 'admin', name: '管理员' },
  title: { name: '执政官', color: '#2563eb' },
};
export const LIN = { handle: 'linshi', nickname: '林诗', role: { key: 'creator', name: '认证创作者' } };
export const XIAO = { handle: 'xiaox', nickname: '某小X' };
export const HE = { handle: 'heshang', nickname: '和尚', role: { key: 'moderator', name: '版主' } };
export const YUN = { handle: 'yunqi', nickname: '云起' };

// 先定类型再收进数组：否则 TS 会把对象字面量推成不含 role 的形状，role 当场报错
const USERS: UserSummary[] = [TANG, LIN, XIAO, HE, YUN];

// 展示用的时间串在**数据层**格式化好（D 节：「列表按 updatedAt 倒序排序，时间已是展示串」）——
// 组件只渲染，不再自己解析时间。
function stamp(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  if (days < 1) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return days + ' 天前';
  const dt = new Date(iso);
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'UTC' }).format(dt);
}

/** 列表与详情都渲染展示串；时间字段在 mock 里是 ISO，便于按相同口径排序（ISO 单调） */
function withStamp(i: RawIssue): IssueDetail {
  return { ...i, createdAt: stamp(i.createdAt), updatedAt: stamp(i.updatedAt) };
}

/** 当前登录者（mock）。「我创建的 / 指派给我」按它的 handle 判。 */
export const ME = { handle: 'linshi', nickname: '林诗' };

// id 直接用编号：W1 的 IssueCard 就以 issue.id 渲染「#编号」（契约里 issue 主键是 public_id）。
// 原始时间先留 ISO：它单调，正好用来按 updatedAt 排序；展示串随后统一生成。
type RawIssue = Omit<IssueDetail, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string };

const RAW_ISSUES: RawIssue[] = [
  {
    id: 128,
    kind: 'bug',
    status: 'open',
    title: '第三章隐藏结局在 15:00 前抵达也不触发',
    bodyMarkdown:
      '按攻略在右上角废墟等事件，**已经提前到 14:20** 了还是没触发。\n\n复现步骤：\n1. 读档到第三章开头；\n2. 直接奔右上角废墟；\n3. 站在圈里等到 15:00，事件不刷新。\n\n存档见附件（Replays 目录）。',
    bodyHtml:
      '<p>按攻略在右上角废墟等事件，<strong>已经提前到 14:20</strong> 了还是没触发。</p><p>复现步骤：</p><ol><li>读档到第三章开头；</li><li>直接奔右上角废墟；</li><li>站在圈里等到 15:00，事件不刷新。</li></ol><p>存档见附件（Replays 目录）。</p>',
    labels: ['战役', '阻塞'],
    author: LIN,
    assignee: TANG,
    commentCount: 5,
    createdAt: T(2, 3),
    updatedAt: T(0, 2),
  },
  {
    id: 127,
    kind: 'feature',
    status: 'open',
    title: '希望支持把整章地图一次导出成 MOD 包',
    bodyMarkdown:
      '现在只能一张一张导，18 张地图导出一次要点 36 下。能不能加一个「导出整章」？\n\n理想情况下还能带上自定义的 GameStrings。',
    bodyHtml:
      '<p>现在只能一张一张导，18 张地图导出一次要点 36 下。能不能加一个「导出整章」？</p><p>理想情况下还能带上自定义的 GameStrings。</p>',
    labels: ['工具链'],
    author: YUN,
    assignee: null,
    commentCount: 2,
    createdAt: T(4, 1),
    updatedAt: T(1, 4),
  },
  {
    id: 126,
    kind: 'difficulty',
    status: 'open',
    title: '第十一张图（虫族）菌毯铺速太快，普通难度也劝退',
    bodyMarkdown:
      '菌毯 3 分钟就铺满半个屏幕，防空还没造完就挨打。建议把铺速降 20%，或者把一开始的工程车从 1 个加到 2 个。',
    bodyHtml: '<p>菌毯 3 分钟就铺满半个屏幕，防空还没造完就挨打。建议把铺速降 20%，或者把一开始的工程车从 1 个加到 2 个。</p>',
    labels: ['平衡性', '战役'],
    author: XIAO,
    assignee: LIN,
    commentCount: 3,
    createdAt: T(6, 2),
    updatedAt: T(0, 6),
  },
  {
    id: 125,
    kind: 'other',
    status: 'open',
    title: '启动器下载页在 4K 屏上按钮被挤出可视区',
    bodyMarkdown: '缩放 150% 的时候，「下载 Windows 版」按钮跑到屏幕外面去了。',
    bodyHtml: '<p>缩放 150% 的时候，「下载 Windows 版」按钮跑到屏幕外面去了。</p>',
    labels: ['界面'],
    author: HE,
    assignee: null,
    commentCount: 1,
    createdAt: T(8, 4),
    updatedAt: T(1, 8),
  },
  {
    id: 124,
    kind: 'bug',
    status: 'closed',
    title: '第一章读档后英雄等级回到 1 级',
    bodyMarkdown: '存档里的等级没跟着走，读档直接白练。',
    bodyHtml: '<p>存档里的等级没跟着走，读档直接白练。</p>',
    labels: ['存档', '已修复'],
    author: YUN,
    assignee: TANG,
    commentCount: 2,
    createdAt: T(12, 3),
    updatedAt: T(1),
  },
  {
    id: 123,
    kind: 'feature',
    status: 'closed',
    title: '帖子支持 Markdown 表格',
    bodyMarkdown: '写攻略时表格比列表清楚，希望能支持。',
    bodyHtml: '<p>写攻略时表格比列表清楚，希望能支持。</p>',
    labels: ['编辑器'],
    author: XIAO,
    assignee: LIN,
    commentCount: 1,
    createdAt: T(15, 5),
    updatedAt: T(5, 2),
  },
  {
    id: 122,
    kind: 'difficulty',
    status: 'closed',
    title: '第二波空投数量与提示不符',
    bodyMarkdown: '提示说 3 个运输机，实际来了 5 个。',
    bodyHtml: '<p>提示说 3 个运输机，实际来了 5 个。</p>',
    labels: ['平衡性'],
    author: HE,
    assignee: null,
    commentCount: 1,
    createdAt: T(20, 1),
    updatedAt: T(9, 4),
  },
  {
    id: 121,
    kind: 'bug',
    status: 'open',
    title: '战役简介里的中文在旧版启动器上显示成方块',
    bodyMarkdown: '老启动器（1.4 之前）读不了新的字体，中文全是方块。要不要给个兼容回退？',
    bodyHtml: '<p>老启动器（1.4 之前）读不了新的字体，中文全是方块。要不要给个兼容回退？</p>',
    labels: ['兼容性'],
    author: TANG,
    assignee: LIN,
    commentCount: 2,
    createdAt: T(22, 6),
    updatedAt: T(10, 2),
  },
];

// 展示串统一在这里生成：列表按 updatedAt 排序，排序与显示必须同源
export const ISSUES: IssueDetail[] = RAW_ISSUES.map((i) => withStamp(i));

// 评论按 issue id 分组；楼中楼是 replies.items（契约：parent_id 只允许指向一级回复）
export const COMMENTS: Record<string, IssueComment[]> = {
  '128': [
    {
      id: 'c1',
      author: TANG,
      body: '确认是 bug：事件计时用的是**读档之后的时间**，不是任务时间。下个补丁改成任务时间。',
      createdAt: '10 月 11 日',
      likes: 12,
      dislikes: 0,
      op: true,
      replies: {
        total: 2,
        previewCount: 2,
        items: [
          { id: 'c1r1', author: LIN, body: '那旧存档还能救吗？', createdAt: '10 月 11 日', likes: 1, dislikes: 0, op: true },
          { id: 'c1r2', author: TANG, body: '能，补丁后重新进图即可，不用重打。', createdAt: '10 月 11 日', likes: 4, dislikes: 0 },
        ],
      },
    },
    { id: 'c2', author: YUN, body: '我也遇到了，第 11 章同样的问题。', createdAt: '10 月 12 日', likes: 2, dislikes: 0 },
    { id: 'c3', author: HE, body: '临时办法：读档后先回主菜单再进，事件会重新计时。', createdAt: '10 月 12 日', likes: 7, dislikes: 1 },
  ],
  '127': [
    { id: 'c4', author: TANG, body: '这个要动导出管线，先记进 v1.2。', createdAt: '10 月 10 日', likes: 3, dislikes: 0 },
    { id: 'c5', author: LIN, body: '+1，我一次要导 6 张，确实烦。', createdAt: '10 月 11 日', likes: 1, dislikes: 0 },
  ],
  '126': [
    {
      id: 'c6',
      author: LIN,
      body: '同意，但降铺速会影响后面的关卡节奏，建议只改第 11 张。',
      createdAt: '10 月 9 日',
      likes: 9,
      dislikes: 0,
      replies: {
        total: 1,
        items: [{ id: 'c6r1', author: XIAO, body: '只改这一张我接受。', createdAt: '10 月 9 日', likes: 2, dislikes: 0 }],
      },
    },
    { id: 'c7', author: YUN, body: '带两个工程车确实好打很多，可以先用这个当过渡方案。', createdAt: '10 月 10 日', likes: 5, dislikes: 0 },
  ],
  '125': [{ id: 'c8', author: TANG, body: '界面问题，我把它挪到这一批修。', createdAt: '10 月 8 日', likes: 0, dislikes: 0 }],
  '124': [
    { id: 'c9', author: TANG, body: '已修复，v1.1.3 起读档保留等级。', createdAt: '10 月 6 日', likes: 15, dislikes: 0, op: true },
    { id: 'c10', author: YUN, body: '验证过了，好了。', createdAt: '10 月 7 日', likes: 3, dislikes: 0 },
  ],
  '123': [{ id: 'c11', author: LIN, body: '表格已上，见编辑器工具栏。', createdAt: '10 月 5 日', likes: 6, dislikes: 0 }],
  '122': [{ id: 'c12', author: HE, body: '确认是提示文案写错了，已改。', createdAt: '10 月 3 日', likes: 2, dislikes: 0 }],
  '121': [
    { id: 'c13', author: LIN, body: '老启动器我们不再维护了，但可以加一张位图字体兜底。', createdAt: '10 月 2 日', likes: 4, dislikes: 1 },
    { id: 'c14', author: YUN, body: '兜底字体 +1。', createdAt: '10 月 2 日', likes: 0, dislikes: 0 },
  ],
};

/** @ 提及候选（契约：GET /api/v1/users/search?q=） */
export const MENTION_CANDIDATES: MentionCandidate[] = USERS.map((u) => ({
  id: u.handle,
  nickname: u.nickname,
  handle: u.handle,
  role: u.role ?? null,
}));
