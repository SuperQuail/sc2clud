import { createElement } from 'react';
import { assetUrl } from '@/lib/url';
import type { Notification, NoticeSettings } from '@/lib/api/social';
import type { Conversation, Peer } from './types';

// 房间的结构性假数据（设计验证页：不 fetch、不接 api client）。
// 头像用 public/art 里现有的图 + 无图时走 UserAvatar 的首字兜底（同一个人每次同色），
// 所以十个人不会看起来像同一个人。
const A = (f: string) => assetUrl(f);

// 名字与 handle 一律取自 完全重构/DevRoom-假数据规范.md 的统一名单（兵种名 + demo- 前缀）。
// DevRoom 是公开部署、无鉴权，mock 会进 bundle —— 这里不许出现真实社区成员。
// 名单里长短名都有，正好用来验证「名字长了会不会把会话行撑破」。
export const ME: Peer = { handle: 'demo-admin', nickname: '示范管理员', avatar: A('miyin-portrait-320.webp') };

const MARINE: Peer = { handle: 'demo-marine', nickname: '陆战队员', avatar: A('miyin-chibi-160.webp') };
const ZEALOT: Peer = { handle: 'demo-zealot', nickname: '狂热者', avatar: A('miyin-wink-260.webp') };
// 头像原来是 miyin-cry-240.webp：这个文件 HTTP 200 但解不开（naturalWidth=0），顺手换成能用的
const HYDRALISK: Peer = { handle: 'demo-hydralisk', nickname: '刺蛇', avatar: A('miyin/smile-160.webp') };
const QUEEN: Peer = { handle: 'demo-queen', nickname: '虫后' };
const SCIENCE: Peer = { handle: 'demo-sciencevessel', nickname: '科学球' };
const GHOST: Peer = { handle: 'demo-ghost', nickname: '幽灵特工' };
const MEDIVAC: Peer = { handle: 'demo-medivac', nickname: '医疗兵' };
const MUTALISK: Peer = { handle: 'demo-mutalisk', nickname: '飞龙' };
const INFESTOR: Peer = { handle: 'demo-infestor', nickname: '感染虫' };

/** 可搜索的聊天对象（选人面板用）。会话列表里的每个人都必须在这里，否则「发私信」找不到人。 */
export const DIRECTORY: Peer[] = [MARINE, ZEALOT, HYDRALISK, QUEEN, SCIENCE, GHOST, MEDIVAC, MUTALISK, INFESTOR];

// ── 私信：文档（可写）─────────────────────────────────────────────
//
// 房间的宿主 ./index.tsx 把这些当服务端用：读走下面几个 getter，写（发送 / 撤回）
// 直接改这份数据，然后靠 react-query 的失效重取 —— 与真站的往返形态一致，
// 所以「发出去的那条会不会出现在气泡里」在房间里就看得出来。

type Draft = { from: 'me' | 'other'; body: string; time: string };


const DOCS: Array<{ peer: Peer; unread: number; drafts: Draft[] }> = [
  {
    peer: MARINE,
    unread: 2,
    drafts: [
      { from: 'other', body: '谢谢关注啦，祝你天天开心哦！我们每个人都是最棒的，不用担心其他，开心是最重要的（￣▽￣）', time: '今天 11:02' },
      { from: 'me', body: '好，回头把第三章的地图发你看下，帮我提提意见。', time: '今天 11:05' },
    ],
  },
  {
    peer: ZEALOT,
    unread: 1,
    drafts: [
      { from: 'me', body: '你那篇攻略里第三章的触发点写得挺准的，学到了。', time: '昨天 22:10' },
      { from: 'other', body: '第十一张图我也卡了三天，菌毯铺得太快，后来带两个工程车才过。', time: '今天 09:41' },
    ],
  },
  {
    peer: HYDRALISK,
    unread: 0,
    drafts: [
      { from: 'other', body: '地图包我周五前整理好发你，里面带上我改过的 GameStrings。', time: '昨天 20:15' },
      { from: 'me', body: '收到，多谢！顺便问下能不能把封面也一起打包。', time: '昨天 20:20' },
    ],
  },
  {
    peer: QUEEN,
    unread: 0,
    drafts: [
      { from: 'me', body: '第二章的空投提示我改成了「三波，每波 3 个运输机」。', time: '昨天 14:58' },
      { from: 'other', body: '好的，那就按这个方案改。', time: '昨天 15:02' },
    ],
  },
  {
    peer: SCIENCE,
    unread: 0,
    drafts: [
      { from: 'other', body: '那个 MOD 包我下了，能跑，谢谢！', time: '10 月 11 日' },
      { from: 'me', body: '有问题随时说。', time: '10 月 11 日' },
    ],
  },
  { peer: GHOST, unread: 0, drafts: [{ from: 'other', body: '明天开黑吗？我这边三个人。', time: '10 月 10 日' }] },
  {
    peer: MEDIVAC,
    unread: 0,
    drafts: [
      { from: 'me', body: '启动器下载页在 4K 屏上按钮会被挤出可视区，你那边能复现吗？', time: '10 月 9 日' },
      { from: 'other', body: '收到，已加进待办。', time: '10 月 9 日' },
    ],
  },
  { peer: MUTALISK, unread: 0, drafts: [{ from: 'other', body: '那我先不改了，等你确认。', time: '10 月 8 日' }] },
];

/** 会话 id 按「第几份文档 + 第几条」生成，稳定可断言（气泡的 key 与撤回按钮都要它）。 */
const idOf = (doc: number, i: number) => 'ci-' + doc + '-' + i;

export function roomConversations(): Conversation[] {
  // 最新说话的排前面（真站的会话列表就是这个序），所以取每份文档的最后一条当摘要
  return DOCS.map((d) => {
    const last = d.drafts[d.drafts.length - 1]!;
    return {
      peer: d.peer,
      messages: [],
      summary: last.body.replace(/\n/g, ' ').slice(0, 24),
      lastAt: last.time,
      unread: d.unread,
    };
  }).sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0));
}

export function roomThread(handle: string) {
  const i = DOCS.findIndex((d) => d.peer.handle === handle);
  const doc = DOCS[i];
  if (!doc) return null;
  return {
    peer: doc.peer,
    next: null,
    items: doc.drafts.map((m, n) => ({
      id: idOf(i, n),
      from: m.from,
      nickname: m.from === 'me' ? ME.nickname : doc.peer.nickname,
      avatar: m.from === 'me' ? ME.avatar : doc.peer.avatar,
      // 后端私信的正文是纯文本 varchar，真站按文本渲染（同一串 class）。这里用 createElement
      // 而不是 JSX：本文件是数据宿主（不是组件文件），.tsx 会踩 react-refresh 的 only-export-components。
      html: createElement('span', { className: 'whitespace-pre-wrap' }, m.body),
      time: m.time,
    })),
  };
}

/** 标已读：房间里就是把这个会话的未读清零（真站是 POST /messages/{handle}/read）。 */
export function roomMarkRead(handle: string) {
  const doc = DOCS.find((d) => d.peer.handle === handle);
  if (doc) doc.unread = 0;
}

/** 标已读：未读数清零 + 那几条通知置成读过（真站是 POST read 与 /notifications/read 的对应物）。 */
export function roomMarkNoticesRead(body: { ids: string[] } | { all: true }) {
  for (const list of Object.values(NOTICES)) {
    for (const n of list) {
      if ('all' in body || body.ids.includes(n.id)) n.read_at = n.read_at ?? '2026-10-14T03:00:00Z';
    }
  }
}

export function roomDeleteNotice(id: string) {
  for (const [kind, list] of Object.entries(NOTICES)) NOTICES[kind] = list.filter((n) => n.id !== id);
}

export function roomSend(handle: string, body: string) {
  DOCS.find((d) => d.peer.handle === handle)?.drafts.push({ from: 'me', body, time: '刚刚' });
}

export function roomRetract(handle: string, id: string) {
  const i = DOCS.findIndex((d) => d.peer.handle === handle);
  const doc = DOCS[i];
  if (!doc) return;
  doc.drafts = doc.drafts.filter((_, n) => idOf(i, n) !== id);
}

// ── 通知四档 ────────────────────────────────────────────────────
//
// 形状照后端 notify/types.go 的 NotificationDTO：payload 里没有的字段不假装有
// （正文在 payload.text，打赏金额在 payload.amount_cents，审核结果在 payload.state）。

const NOTICE = (id: string, kind: string, payload: Record<string, unknown>, link: string, actor: Peer | null, read = false): Notification => ({
  id,
  kind,
  payload,
  link,
  read_at: read ? '2026-10-14T03:00:00Z' : null,
  created_at: '2026-10-14T02:00:00Z',
  actor: actor ? { handle: actor.handle, nickname: actor.nickname, avatar: actor.avatar } : null,
});

export const NOTICES: Record<string, Notification[]> = {
  reply: [
    NOTICE('n-reply-1', 'reply', { text: '回复了我的评论：菌毯推进那套触发器能开源吗' }, '/t/tp-1', QUEEN),
    NOTICE('n-reply-2', 'reply', { text: '回复了我的评论：第三章的空投提示我按你的改了' }, '/t/tp-2', HYDRALISK, true),
  ],
  mention: [NOTICE('n-mention-1', 'mention', { text: '在评论中 @ 了我：@工蜂 @虚空辉光舰 @陆战队员' }, '/t/tp-1', ZEALOT)],
  like: [
    NOTICE('n-like-1', 'like', { text: '等总计 1321 人赞了我的评论' }, '/t/tp-1', MEDIVAC),
    NOTICE('n-like-2', 'like', { text: '等总计 13 人赞了我的评论' }, '/t/tp-2', GHOST, true),
    NOTICE('n-like-3', 'like', { text: '等总计 73 人赞了我的评论' }, '/t/tp-3', SCIENCE),
  ],
  system: [
    NOTICE('n-system-1', 'system', { text: '《社区隐私政策》修订通知：主要更新提示以及更新后的全部内容已发布。' }, '/t/tp-1', null),
    NOTICE('n-review-1', 'review', { state: 'approved', text: '你发布的主题通过了审核' }, '/t/tp-3', null),
    NOTICE('n-sanction-1', 'sanction', { text: '你在「公告」分区被禁言 3 天', until: '2026-10-17T00:00:00Z' }, '', null),
    NOTICE('n-reward-1', 'reward', { text: '收到打赏', amount_cents: 1000 }, '/u/demo-marine', MEDIVAC),
  ],
};

/** 静音是**类别级**的（PUT /notifications/mutes 只带 type）：这一类的通知从列表里消失。 */
const MUTED = new Set<string>();
export function roomMuteKind(kind: string) {
  MUTED.add(kind);
}
export const roomMuted = () => MUTED;

export function roomNotices(kind: string): Notification[] {
  const kinds = kind.split(',').filter((k) => !MUTED.has(k));
  return kinds.flatMap((k) => NOTICES[k] ?? []);
}

/** 通知设置：与后端 0018 的 CHECK 值域逐字一致（只有 all / none），可写。 */
export const NOTICE_SETTINGS: NoticeSettings = { alert: true, reply_scope: 'all', mention_scope: 'all', like_alert: true };
