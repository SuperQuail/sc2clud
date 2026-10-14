import { useEffect, useMemo, useState } from 'react';
import { NoticeCenterView } from './notice-center-view';
import { panelOfNavKey, resolveNoticeKind, type NoticeSources, type Panel } from './notice-logic';
import {
  DIRECTORY,
  ME,
  NOTICES,
  NOTICE_SETTINGS,
  roomConversations,
  roomMarkRead,
  roomNotices,
  roomRetract,
  roomSend,
  roomThread,
} from './mock-data';

// DevRoom 10 · 信息中心 —— **这一页是宿主**（取数 + 把档位写进 URL），版面在 ./notice-center-view。
//
// 2026-10-14（修 D10）：本页此前把档位与当前会话存在 useState 里、只把 URL 当挂载初值读一次 ——
// 于是「点导航只改 state、URL 不变」，而真站是「点导航只改 URL」。两个入口各有半套真源，
// 合起来就是 D10 报的那个现象（URL 变了、选中态与右栏不换）。现在两边同一套：
// **URL 是唯一真源**，View 只吃 props，宿主负责读写 ?panel= / ?kind= / ?peer=。
//
// 房间没有 react-router（app.tsx 只认 ?page=），所以这里用 history：写 query 与真站的
// useSearchParams 是同一个效果（可刷新、可后退、可分享），断言查的也是 location.search。
//
// 数据是 ./mock-data 的结构性假数据：形状照后端 DTO（notify/types.go、message/types.go），
// 写动作（发送 / 撤回 / 标已读 / 存设置）就地改那份数据、再让 react-query 失效重取 ——
// 与真站的往返形态一致，不是「点了只回执」的假动作。

const readQuery = () => new URLSearchParams(window.location.search);

/** 房间宿主：把 ?panel= / ?kind= / ?peer= 读出来喂 View，View 的点击再写回去。 */
function useRoomQuery() {
  const [query, setQuery] = useState(readQuery);
  useEffect(() => {
    const sync = () => setQuery(readQuery());
    // 后退/前进也要跟着走（房间自己不 push，但地址栏被改时必须一致）
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const write = (next: URLSearchParams) => {
    const q = next.toString();
    history.replaceState(null, '', window.location.pathname + (q === '' ? '' : '?' + q));
    setQuery(new URLSearchParams(next));
  };
  return [query, write] as const;
}

/** 房间的数据端口：假数据 + 本地写。与真站传 lib/api 是同一个接口（./notice-logic 的 NoticeSources）。 */
function roomSources(peer: string | null): NoticeSources {
  return {
    conversations: () => delay({ items: roomConversations(), next: null }),
    thread: (handle) => {
      const t = roomThread(handle);
      return t ? delay(t) : Promise.reject(new Error('房间里没有这个会话：' + handle));
    },
    unreadMessages: () => delay(roomConversations().reduce((n, c) => n + c.unread, 0)),
    notices: (kind) => delay({ items: roomNotices(kind), next: null }),
    unreadNotices: () => delay(Object.values(NOTICES).flat().filter((n) => !n.read_at).length),
    settings: () => delay({ ...NOTICE_SETTINGS }),
    searchPeers: (q) => delay(DIRECTORY.filter((p) => p.nickname.includes(q) || p.handle.includes(q))),
    saveSettings: (next) => {
      Object.assign(NOTICE_SETTINGS, next);
      return delay({ ...next });
    },
    sendMessage: (handle, body) => {
      roomSend(handle, body);
      return delay(null);
    },
    retractMessage: (id) => {
      if (peer) roomRetract(peer, id);
      return delay(null);
    },
    markThreadRead: (handle) => {
      roomMarkRead(handle);
      return delay(null);
    },
    // 房间不删通知、不静音（真站那两条打的是 DELETE /notifications/{id} 与 PUT /notifications/mutes）：
    // 不给动作槽位，而不是给一个点了只回执的按钮 ——「看起来成功了」正是这份清单要消灭的形态。
  };
}

const delay = <T,>(v: T): Promise<T> => new Promise((r) => window.setTimeout(() => r(v), 120));

export default function MessagesPage() {
  const [query, setQuery] = useRoomQuery();
  const panel: Panel = (query.get('panel') as Panel | null) ?? 'messages';
  const kind = resolveNoticeKind(query.get('kind') ?? 'reply');
  const peer = query.get('peer');
  const sources = useMemo(() => roomSources(peer), [peer]);

  /** 把三件状态写成 URL：`?panel=` 一律写出来（缺省档也要显式，见 notice-logic 的 panelOfNavKey 注释），
   *  kind 只挂在通知档、peer 只在私信档 —— 与真站 setSearchParams 那套规则逐条相同。 */
  function write(next: { panel: Panel; kind?: string | null; peer?: string | null }) {
    // 保留 page=：房间靠它决定渲染哪一页（main.tsx 只在启动时读一次），写 URL 时不能把它弄丢
    const q = new URLSearchParams(query);
    q.set('panel', next.panel);
    q.delete('kind');
    q.delete('peer');
    if (next.panel === 'notices' && next.kind) q.set('kind', next.kind);
    if (next.panel === 'messages' && next.peer) q.set('peer', next.peer);
    setQuery(q);
  }

  /** 点导航：目标档由 panelOfNavKey 解出（'kind:xxx' 的命名空间在 View 那一侧） */
  function nav(key: string) {
    const t = panelOfNavKey(key);
    // kind 档：key 里的 kind 值就是要写的值
    write({ panel: t.panel, kind: t.kind ?? kind, peer });
  }

  return (
    <div className='relative left-1/2 w-[min(1280px,calc(100vw-32px))] -translate-x-1/2'>
      <p className='mb-2 px-1 text-[11px] leading-relaxed text-muted-foreground'>
        本页的件都来自 <code>src/ui/message/</code>。其中
        <strong className='font-medium text-foreground'>CountBadge</strong>
        （未读数字角标）没有独立入口：它出现在会话列表的未读角标上。 档位与当前会话都写在地址栏（
        <code>?panel=</code> / <code>?kind=</code> / <code>?peer=</code>），与真站同一个真源 ——
        点导航后刷新、后退、分享链接都停在同一档。
      </p>
      <NoticeCenterView
        panel={panel}
        kind={kind}
        peer={peer}
        onNav={nav}
        onPeer={(handle) => write({ panel: 'messages', peer: handle })}
        sources={sources}
        session={{ isLoading: false, loggedIn: true, nickname: ME.nickname, avatar: ME.avatar }}
      />
    </div>
  );
}
