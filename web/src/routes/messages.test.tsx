import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { MessagesPage, NotificationsPage } from './messages';

// 「系统通知」一档必须是 system / review / sanction / reward **四类合一**（B1）：
//   值域在 forum/internal/notify/kinds.go，后端 ?kind= 认逗号分隔（46d7c04，service.go:200 parseListKinds）。
// 这一条盯的是「值域里有、界面上没有入口」那类缺陷：审核结果 / 被禁言 / 打赏到账原先只能靠自己拼 URL 才看得到。
afterEach(() => {
  vi.unstubAllGlobals();
});

const ME = { handle: 'demo-marine', nickname: '陆战队员', perms: [], is_super: false, email_verified: true };

const N = (id: string, kind: string, payload: Record<string, unknown>) => ({
  id,
  kind,
  payload,
  link: '/t/tp-1',
  read_at: null,
  created_at: '2026-10-14T02:00:00Z',
  actor: { handle: 'demo-admin', nickname: '示范管理员', avatar: null, avatar_small: null },
});

const REPLY = N('n-1', 'reply', { text: '回复了你的主题' });
const SYSTEM = N('n-2', 'sanction', { text: '你被禁言 3 天' });

/** 一次写请求（POST / PUT / DELETE）的方法与请求体，用来断言「到底发了什么」。 */
type WriteCall = { method: string; url: string; body: unknown };

/** 网络边界：记下每个列表请求的 URL，答什么由 byKind 决定（后端按 kind 过滤，桩也按 kind 过滤）。 */
function mockApi(writes: WriteCall[] = []) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (init?.method && init.method !== 'GET') {
        writes.push({ method: init.method, url: u, body: init.body ? JSON.parse(String(init.body)) : null });
        // httpx.NoContent：PUT/DELETE /notifications/mutes 的响应体是空的（不是 {data:...}）
        return new Response(null, { status: 204 });
      }
      const body = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (new URL(u, 'http://x').pathname.endsWith('/api/v1/me')) return body(ME);
      if (u.includes('/api/v1/site')) return body({ name: 'SC2clud', announcements: [], banner: null });
      if (u.includes('/api/v1/notifications/settings')) return body({ alert: 'all', reply_scope: 'all', mention_scope: 'all', like_alert: 'all' });
      if (u.includes('/api/v1/notifications/unread')) return body({ count: 2 });
      if (u.includes('/api/v1/notifications')) {
        const kind = new URL(u, 'http://x').searchParams.get('kind') ?? '';
        const kinds = kind.split(',');
        return body([REPLY, SYSTEM].filter((n) => kinds.includes(n.kind)));
      }
      return new Response(JSON.stringify({ error: { code: 'common.not_found', message: u } }), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

/** 把 MemoryRouter 里的当前查询串写进 DOM：断言要读的是**地址栏**，不是组件内部的字段。
 *  （MemoryRouter 不进 HTML5 history，所以 location.search 读不到它 —— 那正是它存在的意义。） */
const URL_PROBE_ID = 'notice-center-location';
function LocationProbe() {
  const { search } = useLocation();
  return (
    <p data-testid={URL_PROBE_ID} className='sr-only'>
      {search}
    </p>
  );
}

function renderCenter(path = '/notifications') {
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path='/notifications'
            element={
              <>
                <LocationProbe />
                <NotificationsPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

it('「系统通知」一档一次带四类 kind，并把 review / sanction / reward 的通知渲染出来', async () => {
  const calls = mockApi();
  renderCenter();
  // 默认档是「回复我的」：单值
  expect(await screen.findByText(/回复了你的主题/)).toBeTruthy();
  expect(calls.some((u) => u.includes('kind=reply'))).toBe(true);

  // 切到「系统通知」：一次请求带回四类
  fireEvent.click(screen.getByTestId('notice-nav-kind:system,review,sanction,reward'));
  expect(await screen.findByText(/你被禁言 3 天/)).toBeTruthy();
  const systemCall = calls.find((u) => u.includes('kind=system'));
  // 四类里的 review / reward 也在这条请求的返回值里（不是只查 kind=system）；
  // 逗号被 URLSearchParams 编码成 %2C 是正常的，所以断言解码后的值
  expect(new URL(systemCall!, 'http://x').searchParams.get('kind')?.split(',')).toEqual([
    'system',
    'review',
    'sanction',
    'reward',
  ]);
});

// G1：通知行的「不再通知」必须打到 PUT /notifications/mutes，且**体里只有 type**。
// 这一条盯的是契约形状：muteKey 对「整类静音却带了 ref_type/ref_id」直接 400
// （notify/service.go:278-282）——接口返回 400、界面看着像点过了，是这类缺陷的典型形态。
it('点「不再通知此类」发 PUT /notifications/mutes 且只带 type（不误发 ref_type/ref_id）', async () => {
  const writes: WriteCall[] = [];
  mockApi(writes);
  renderCenter();
  // 切到「系统通知」档，拿一条 kind=sanction 的行
  fireEvent.click(screen.getByTestId('notice-nav-kind:system,review,sanction,reward'));
  const action = await screen.findByTestId('notice-action-mute-n-2');
  fireEvent.click(action);

  // 点过的行不再给同一个入口（本地记账；后端没有 GET /mutes，见进度文件）
  await waitFor(() => expect(screen.queryByTestId('notice-action-mute-n-2')).toBeNull());
  expect(writes).toHaveLength(1);
  expect(writes[0]!.method).toBe('PUT');
  expect(writes[0]!.url).toContain('/api/v1/notifications/mutes');
  expect(writes[0]!.body).toEqual({ type: 'sanction' });
});

const PEER = { handle: 'demo-marine', nickname: '陆战队员', avatar: null, avatar_small: null };
const MINE = { id: 'm-1', body: '这条是我发的', mine: true, read: false, created_at: '2026-10-14T02:00:00Z' };
const THEIRS = { id: 'm-2', body: '这条是他发的', mine: false, read: true, created_at: '2026-10-14T01:00:00Z' };

/** 私信桩：会话列表 + 会话页 + 发送。方法不是 GET 的走上面的写请求分支。 */
function mockMessages(thread: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method && init.method !== 'GET') return new Response(null, { status: 204 });
      // **按路径精确匹配 /me**：'/api/v1/messages' 里也含有 '/api/v1/me' 这一段，
      // 用 includes 会让每个私信请求都拿到「我是谁」（实测：整屏渲染成空态）。
      if (new URL(u, 'http://x').pathname.endsWith('/api/v1/me')) return json(ME);
      if (u.includes('/api/v1/site')) return json({ name: 'SC2clud', announcements: [], banner: null });
      if (u.includes('/api/v1/messages/unread-count')) return json({ count: 1 });
      // 会话页 = /messages/<handle>；/messages/read 那种子路径不算（它是 POST，走上面的写分支）
      // 会话页 = /messages/<handle>：**用 pathname 判**，u 上带着 ?limit=20，锚点会匹配不上
      // （实测：匹配不上就掉到列表分支，响应里没有 peer → 会话头读 .nickname 崩）。
      if (/\/api\/v1\/messages\/[^/?]+$/.test(new URL(u, 'http://x').pathname) && !u.includes('/read')) {
        // 会话页的包络比列表多一个 peer（d4 §5.2）
        return new Response(JSON.stringify({ data: thread, next_cursor: null, peer: PEER }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/api/v1/messages')) return json([{ peer: PEER, unread_count: 1, last: MINE }]);
      return new Response(JSON.stringify({ error: { code: 'common.not_found', message: u } }), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
}

// G2：撤回私信要打到 DELETE /api/v1/messages/{id}，而且**只给自己发的那条**入口
// （后端 DeleteMessage 是「各自删除」：只置我这一侧的标记，对方照常看得见；
//  不在我参与的会话里 404 —— 所以别人那条本来也撤不掉，不给入口而不是点了报错）。
it('私信页：自己那条有「撤回」，点它发 DELETE /api/v1/messages/{id}；对方那条没有入口', async () => {
  const writes: WriteCall[] = [];
  mockMessages([MINE, THEIRS]);
  // 写请求要记账，所以在 mock 之上再包一层（mockMessages 只答读）
  const inner = globalThis.fetch as unknown as (u: string | URL | Request, i?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', async (u: string | URL | Request, i?: RequestInit) => {
    if (i?.method && i.method !== 'GET') {
      writes.push({ method: i.method, url: String(u), body: i.body ? JSON.parse(String(i.body)) : null });
      return new Response(null, { status: 204 });
    }
    return i === undefined ? inner(u) : inner(u, i);
  });

  render(
    <Providers>
      <MemoryRouter initialEntries={['/messages/demo-marine']}>
        <Routes>
          <Route path='/messages/:handle' element={<MessagesPage />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );

  fireEvent.click(await screen.findByTestId('message-retract-m-1'));
  await waitFor(() => expect(writes.some((w) => w.method === 'DELETE' && w.url.endsWith('/api/v1/messages/m-1'))).toBe(true));
  // 对方那条没有撤回入口
  expect(screen.queryByTestId('message-retract-m-2')).toBeNull();
});

it('旧书签的单值 ?kind=review 落到「系统通知」这一档（不显示成「回复我的」）', async () => {
  const calls = mockApi();
  renderCenter('/notifications?kind=review');
  expect(await screen.findByText(/你被禁言 3 天/)).toBeTruthy();
  // 归一成多值再问后端，界面上的档位名也是「系统通知」
  expect(calls.some((u) => new URL(u, 'http://x').searchParams.get('kind') === 'system,review,sanction,reward')).toBe(true);
  // Ring 的 Button 没有 aria-pressed，选中态是类名
  expect(screen.getByTestId('notice-nav-kind:system,review,sanction,reward').className).toContain('ring-button-active');
});

// D10 的验收：**点哪一档，URL、选中态、右侧面板三者同时变**（缺陷清单 D10 的原话）。
//
// 为什么这条断言必须存在：D10 报的「URL 变但选中态不变、右侧面板也不换」正是**两套真源**的形态 ——
// 档位一旦有一半留在组件 state 里，就能出现「地址栏说 A、界面在 B」。这条把它钉成一句话：
// 三处只允许同时变。列表请求也跟着 kind 走，所以顺带钉住「面板真的换了数据源」。
it('点每一档：URL、选中态、右侧面板三者同时变（单一真源 = URL）', async () => {
  const calls = mockApi();
  renderCenter();
  expect(await screen.findByText(/回复了你的主题/)).toBeTruthy();

  // 选中态在 Ring 里是类名（Button 没有 aria-pressed）
  const on = (key: string) => screen.getByTestId('notice-nav-' + key).className.includes('ring-button-active');
  expect(on('kind:reply')).toBe(true);

  // ① 「收到的赞」：URL 落到 panel + kind，选中态跟着走，右栏换成那一档的列表
  fireEvent.click(screen.getByTestId('notice-nav-kind:like'));
  expect(screen.getByTestId(URL_PROBE_ID).textContent, 'URL').toContain('kind=like');
  expect(on('kind:like')).toBe(true);
  expect(on('kind:reply')).toBe(false);
  expect(screen.getByTestId('notice-list').textContent).toContain('收到的赞');
  // ② 列表请求也换了档（面板不是只有标题变了）
  expect(calls.some((u) => new URL(u, 'http://x').searchParams.get('kind') === 'like')).toBe(true);

  // ③ 「消息设置」：panel=settings，且 kind 不再挂在 URL 上（切档不留旧参数）
  fireEvent.click(screen.getByTestId('notice-nav-settings'));
  expect(screen.getByTestId(URL_PROBE_ID).textContent).toContain('panel=settings');
  expect(screen.getByTestId(URL_PROBE_ID).textContent).not.toContain('kind=');
  expect(on('settings')).toBe(true);
  expect(await screen.findByText('消息提醒')).toBeTruthy();
});

// ── L11：通知的实时性 ────────────────────────────────────────────
//
// 老站的客户端（site/crates/sc2clud-web/templates/inbox.html:242-276）是两件事叠在一起：
// EventSource 为主 + setInterval(pull, 30000) 兜底。这条盯的就是这两件事真的接上了 ——
// **jsdom 没有 EventSource**，所以用例自造一个最小替身（记地址、能开、能派事件）。

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<() => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  /** 服务端推来一个「变了」的信号 */
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  open() {
    this.onopen?.();
  }
}

it('通知中心建 SSE 流：地址走 api/v1/notifications/stream；连上显示「实时」，收到信号后重取', async () => {
  const calls = mockApi();
  vi.stubGlobal('EventSource', FakeEventSource);
  renderCenter();
  await screen.findByText(/回复了你的主题/);

  const es = FakeEventSource.last;
  expect(es).not.toBeNull();
  expect(es!.url).toContain('/api/v1/notifications/stream');
  expect(es!.closed).toBe(false);

  // 连上之前不许说「实时」（否则「实时坏了」永远看不出来），onopen 之后必须说
  expect(screen.getByText(/每 30 秒同步一次/)).toBeTruthy();
  es!.open();
  expect(await screen.findByText(/实时同步/)).toBeTruthy();

  // 信号只触发**重取**，不携带正文（事件体只有 {changed:true}，见 forum/internal/notify/stream.go）
  // 信号只触发**重取**，不携带正文（事件体只有 {changed:true}，见 forum/internal/notify/stream.go）。
  // 这一档面板里由 NoticeCenter 自己拉的只有列表（角标在 NoticesHeader，那条用例不渲染它），
  // 所以数列表请求。
  const count = () => calls.filter((u) => u.includes('/api/v1/notifications?')).length;
  const before = count();
  es!.emit('unread');
  await waitFor(() => expect(count()).toBeGreaterThan(before));
});
