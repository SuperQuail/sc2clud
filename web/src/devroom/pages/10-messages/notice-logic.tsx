import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AtSign, Bell, MessageSquare, Settings, Send, ThumbsUp } from 'lucide-react';
import { appPath } from '@/lib/url';
import { formatCents } from '@/lib/format';
import type { Notification, NoticeSettings as NoticeSettingsDTO } from '@/lib/api/social';
import type { ChatMessage } from '@/ui/message/notice-chat';
import type { NoticeNavItem } from '@/ui/message/notice-nav';
import type { Conversation, Peer } from './types';

// 信息中心（DevRoom 10-messages）的**数据端口 + 派生的界面状态**。
//
// 为什么要有它：清单 §0 要求「页面 = prop 驱动的 View + 极薄宿主」，而这一屏的 View 由**两个入口**
// 渲染 —— 真站（routes/messages.tsx，接真端点）与 DevRoom 10-messages（假数据，房间里不 fetch）。
// 两个入口的差别只允许在**数据来源**：版面 / 文案 / 四态逐字相同，所以取数按端口注入。
// 产品宿主传 lib/api 的函数，房间宿主传 ./mock-source —— 换的是数据，不是页面。
// （2026-10-14 修 D10 时定的形状。此前房间与真站各写一份，于是「URL 变了界面不变」这类缺陷
//   只会在其中一边出现，另一边永远发现不了。）

/** 一页数据；与 lib/api 的 Paged 同形（后端游标分页的包络）。 */
export type Page<T> = { items: T[]; next: string | null };

/** 会话列表的行：**展示形状**（summary / lastAt 已格式化）——DTO 到它的换算是宿主的事。 */
export type ConversationRow = Conversation;

/** 与某人的会话：气泡（时间序，最早在上）+ 对方 + 是否还有更早的。 */
export type Thread = { peer: Peer; items: ChatMessage[]; next: string | null };

/** 选中档（URL 的 ?panel=）；通知那四档统一落在 notices + ?kind=。 */
export type Panel = 'notices' | 'messages' | 'settings';

/**
 * 这一屏要的全部数据动作，**都由宿主提供**：真站传 lib/api 的函数，DevRoom 传本地假数据。
 * 只读的那几个必给；写动作可选，不给就当作「这一档在房间里不落库」（例如房间不标已读）。
 */
export type NoticeSources = {
  conversations: (cursor: string | null, signal?: AbortSignal) => Promise<Page<ConversationRow>>;
  thread: (peer: string, signal?: AbortSignal) => Promise<Thread>;
  unreadMessages: (signal?: AbortSignal) => Promise<number>;
  notices: (kind: string, cursor: string | null, signal?: AbortSignal) => Promise<Page<Notification>>;
  unreadNotices: (signal?: AbortSignal) => Promise<number>;
  settings: (signal?: AbortSignal) => Promise<NoticeSettingsDTO>;
  /** 「选择聊天对象」弹层里的搜人（q 为空时不该发请求，由 View 保证） */
  searchPeers: (q: string, signal?: AbortSignal) => Promise<Peer[]>;
  saveSettings?: (next: NoticeSettingsDTO) => Promise<NoticeSettingsDTO>;
  sendMessage?: (peer: string, body: string) => Promise<unknown>;
  retractMessage?: (id: string) => Promise<unknown>;
  markThreadRead?: (peer: string) => Promise<unknown>;
  markNoticesRead?: (body: { ids: string[] } | { all: true }) => Promise<unknown>;
  deleteNotice?: (id: string) => Promise<unknown>;
  muteKind?: (kind: string) => Promise<unknown>;
};

/** 通知分档 → 后端 kind= 的多值串（值域逐字照 forum/internal/notify/kinds.go，后端认逗号分隔）。 */
export const NOTICE_KINDS: Array<{ kinds: string[]; label: string; icon: LucideIcon }> = [
  { kinds: ['reply'], label: '回复我的', icon: Send },
  { kinds: ['mention'], label: '@ 我的', icon: AtSign },
  { kinds: ['like'], label: '收到的赞', icon: ThumbsUp },
  { kinds: ['system', 'review', 'sanction', 'reward'], label: '系统通知', icon: Bell },
];

const KIND_SEP = ',';

/** kind= → 档位值的归一：四类合一的档在 URL 上是一串，旧书签的单值（?kind=review）也要落到它那一档。 */
export function resolveNoticeKind(raw: string): string {
  const one = NOTICE_KINDS.find((t) => t.kinds.join(KIND_SEP) === raw || t.kinds.includes(raw));
  return (one ?? NOTICE_KINDS[0]!).kinds.join(KIND_SEP);
}

/**
 * 左栏导航项与选中值。**选中值只能从 panel/kind 推**（下面 value 那一行），
 * 所以「URL / 选中态 / 右栏面板」三处天然同源 —— D10 报的「URL 变、选中态不变」
 * 正是把档位另存了一份在组件 state 里。
 */
export function noticeNav(panel: Panel, kind: string, counts?: { likes?: number }): {
  items: NoticeNavItem[];
  value: string;
} {
  const items: NoticeNavItem[] = [
    { key: 'messages', label: '我的消息', icon: <MessageSquare aria-hidden className='size-4' /> },
    ...NOTICE_KINDS.map((k) => ({
      key: 'kind:' + k.kinds.join(KIND_SEP),
      label: k.label,
      icon: <k.icon aria-hidden className='size-4' />,
      count: k.kinds.includes('like') ? counts?.likes : undefined,
    })),
    { key: 'settings', label: '消息设置', icon: <Settings aria-hidden className='size-4' />, groupTitle: '设置' },
  ];
  const value = panel === 'messages' ? 'messages' : panel === 'settings' ? 'settings' : 'kind:' + kind;
  return { items, value };
}

/** 点击导航项 → 目标档（kind: 前缀是导航的命名空间，见 noticeNav 的注释）。 */
export function panelOfNavKey(key: string): { panel: Panel; kind?: string } {
  if (key.startsWith('kind:')) return { panel: 'notices', kind: key.slice(5) };
  return { panel: key as Panel };
}

/** 取值与迁移 0004 的 ck_topics_review_state 逐字相同。 */
export const REVIEW_STATE: Record<string, string> = {
  pending: '仍在审核',
  approved: '已通过',
  rejected: '未通过',
};

/** 通知动作的文案（值域照 notify/kinds.go）。 */
export const KIND_ACTION: Record<string, string> = {
  reply: '回复了我',
  mention: '在回复里 @ 了我',
  like: '赞了我',
  reward: '给我打赏',
  review: '我的帖子有了审核结果',
  sanction: '我的账号被处罚',
  system: '发来一条系统通知',
};

function text(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 这一条的正文（拿不到就不显示，不编）—— payload 里没有的字段不假装有。 */
export function noticeDetail(n: { kind: string; payload?: Record<string, unknown> | null }): ReactNode {
  const p = n.payload ?? {};
  const body = text(p.text);
  if (n.kind === 'reward') {
    const cents = typeof p.amount_cents === 'number' ? p.amount_cents : null;
    return cents === null ? body : '金额 ¥' + formatCents(cents);
  }
  if (n.kind === 'review') {
    const state = text(p.state);
    return state ? '结果：' + (REVIEW_STATE[state] ?? state) + (body ? ' · ' + body : '') : body;
  }
  return body;
}

/**
 * link 是站内路径（形如 "/t/<public_id>"）—— 必须去掉前导斜杠再交给 appPath，
 * 否则 new URL("/t/x", "/dev/") 会把它解析成站点根，跳出 /dev 前缀。
 */
export function noticeLink(n: { link: string }): string | null {
  const l = (n.link ?? '').replace(/^\/+/, '');
  return l === '' ? null : appPath(l);
}
