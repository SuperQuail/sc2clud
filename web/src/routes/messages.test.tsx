import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { MessagesPage, NoticeCenter } from './messages';

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

function renderCenter(path = '/notifications') {
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path='/notifications' element={<NoticeCenter panel='notices' />} />
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
