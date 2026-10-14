import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { ProfilePage } from './profile';

// 个人主页**真站这一页**的接线断言（房间那一屏由 11-profile 自己的测试盯）。
// 契约真源：forum/internal/title/{handler,types}.go —— GET /users/{handle}/titles 回
// { items: TitleDTO[], equipped_id }（"" = 未佩戴），PUT /me/title 收 { title_id }（null/"" = 卸下）回 204。
// 后端不在本地，所以这里只换网络边界：请求打没打到、请求体的字段名对不对，都是断言的一部分。
afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { status?: number; body?: unknown };
const calls: Array<{ url: string; method: string; body: unknown }> = [];
function mockApi(byPath: (path: string, method: string) => Reply) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const path = new URL(u, 'http://x').pathname;
      calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply = byPath(path, method);
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const ME = {
  data: {
    id: 'u1',
    handle: 'demo-admin',
    nickname: '示范管理员',
    avatar: null,
    email_verified: true,
    perms: [],
    is_super: false,
    role: { key: 'admin', name: '管理员' },
  },
};

/** user.Profile 是**平铺的**（forum/internal/user/service.go:52-68），title 只给佩戴中的那一个。 */
const profile = (title: unknown) => ({
  data: {
    id: 'u1',
    handle: 'demo-admin',
    nickname: '示范管理员',
    avatar: '',
    avatar_small: '',
    cover: '',
    bio: '战役作者',
    status: 'normal',
    level: 27,
    exp: 640,
    exp_max: 1000,
    topic_count: 86,
    like_received: 12480,
    joined_at: '2024-03-02T00:00:00Z',
    title,
  },
});

// 本人**持有**的两个头衔（title.TitleDTO 逐字）：id 是 public_id，PUT /me/title 要的就是它
const TITLES = {
  data: {
    items: [
      { id: 'ti-1', key: 'consul', name: '执政官', color: '#2563eb', description: '', archived_at: null },
      { id: 'ti-2', key: 'champion', name: '首席设计师', color: '#16a34a', description: '', archived_at: null },
    ],
    equipped_id: 'ti-1',
  },
};

const CURRENT = { name: '执政官', color: '#2563eb' };

function renderProfile(handle: string) {
  return render(
    <Providers>
      <MemoryRouter initialEntries={['/u/' + handle]}>
        <Routes>
          <Route path='/u/:handle' element={<ProfilePage />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

function stubProfile(me: boolean) {
  mockApi((path) => {
    if (path.endsWith('/api/v1/me')) return { body: me ? ME : { data: null } };
    if (path.endsWith('/api/v1/users/demo-admin/titles')) return { body: TITLES };
    if (path.endsWith('/api/v1/users/demo-admin/topics')) return { body: { data: [], next_cursor: null } };
    if (path.endsWith('/api/v1/users/demo-admin')) return { body: profile(CURRENT) };
    if (path.endsWith('/api/v1/me/donation-settings')) {
      return { body: { data: { show_channels: true, records_public: false, notice_visible: true, notice_text: '' } } };
    }
    return { status: 404, body: { error: { code: 'common.not_found', message: '没有这条桩：' + path } } };
  });
}

// D18：本人主页的头衔**可点**，点开是「我持有的头衔 + 不佩戴」，选完调 PUT /me/title。
it('D18：本人点头衔 → 下拉（持有的头衔 + 不佩戴）→ 选中即 PUT /me/title', async () => {
  stubProfile(true);
  renderProfile('demo-admin');
  // hero 上的头衔就是那枚普通徽标（常态看不出可交互），点击才展开
  await screen.findByTestId('dropdown-trigger');
  fireEvent.click(screen.getByTestId('dropdown-trigger'));
  const menu = await screen.findByTestId('dropdown-content');
  expect(menu.textContent).toContain('首席设计师');
  expect(menu.textContent).toContain('不佩戴');

  fireEvent.click(screen.getByText('首席设计师'));
  await waitFor(() => {
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url.endsWith('/api/v1/me/title')).toBe(true);
    expect(put?.body).toEqual({ title_id: 'ti-2' });
  });
});

// 「不佩戴」= title_id 空串（后端 title.Equip："" 就 ClearEquippedTitleID）
it('D18：选「不佩戴」发的是空 title_id', async () => {
  stubProfile(true);
  renderProfile('demo-admin');
  fireEvent.click(await screen.findByTestId('dropdown-trigger'));
  await screen.findByTestId('dropdown-content');
  fireEvent.click(screen.getByText('不佩戴'));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && (c.body as { title_id?: string }).title_id === '')).toBe(true));
});

// 别人主页：只显示、不可点 —— 连下拉触发器都不该存在（不是「点了没反应」）
it('D18：别人主页的头衔不可点（没有下拉触发器）', async () => {
  stubProfile(false);
  renderProfile('demo-admin');
  // 这一页头衔出现两次（hero 的身份行 + 右栏「徽章」格），所以用 findAll —— 哪一处都不该变成下拉
  await screen.findAllByText('执政官');
  expect(screen.queryByTestId('dropdown-trigger')).toBeNull();
});

// 没有头衔且是本人：不显示假占位（接 D16 的口径）
it('D18：本人没有头衔时不画假占位（不出现「无头衔」）', async () => {
  mockApi((path) => {
    if (path.endsWith('/api/v1/me')) return { body: ME };
    if (path.endsWith('/api/v1/users/demo-admin/titles')) return { body: { data: { items: [], equipped_id: '' } } };
    if (path.endsWith('/api/v1/users/demo-admin/topics')) return { body: { data: [], next_cursor: null } };
    if (path.endsWith('/api/v1/users/demo-admin')) return { body: profile(null) };
    if (path.endsWith('/api/v1/me/donation-settings')) return { body: { data: { show_channels: false, records_public: false, notice_visible: false, notice_text: '' } } };
    if (path.endsWith('/api/v1/users/demo-admin/channels')) return { body: { data: [] } };
    return { status: 404, body: { error: { code: 'common.not_found', message: '没有这条桩：' + path } } };
  });
  const { container } = renderProfile('demo-admin');
  await screen.findByText('示范管理员');
  expect(container.textContent).not.toContain('无头衔');
  expect(screen.queryByTestId('dropdown-trigger')).toBeNull();
});
