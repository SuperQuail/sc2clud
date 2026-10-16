import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const profile = (title: unknown, handle = 'demo-admin', cover = '') => ({
  data: {
    id: 'u1',
    handle,
    nickname: '示范管理员',
    avatar: '',
    avatar_small: '',
    cover,
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

/** follow.UserItem 逐字（forum/internal/follow/types.go:32）：头像两根都是**裸哈希**，'' = 没有。 */
const FOLLOWER = { id: 'u-9', handle: 'demo-drone', nickname: '工蜂', avatar_hash: '', avatar_small_hash: '', followed_at: '2026-10-11T00:00:00Z' };

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

/**
 * 主页的桩：`handle` 是被看的那个人（默认 = 会话里那个人 = 本人主页）。
 * `following` 是**关注态的真源**，PUT / DELETE 之后它会变 —— 「态以服务端回执为准」这条断言
 * 只有在桩跟着变的时候才有意义（回执不动，本地翻转也能骗过断言）。
 */
function stubProfile(opts: { me?: boolean; handle?: string; following?: boolean; cover?: string } = {}) {
  const handle = opts.handle ?? 'demo-admin';
  const me = opts.me !== false;
  let following = opts.following ?? false;
  mockApi((path, method) => {
    if (path.endsWith('/api/v1/me')) return { body: me ? ME : { data: null } };
    // follow.State（forum/internal/follow/types.go）：target / handle / following / follower_count
    if (path === '/api/v1/users/' + handle + '/follow') {
      // GET 只是**读**当前态（改它就不是「读」了）；PUT/DELETE 才是幂等的两端
      if (method === 'PUT') following = true;
      if (method === 'DELETE') following = false;
      return { body: { data: { target: 'user', handle, following, follower_count: following ? 128 : 127 } } };
    }
    // 关注者（GET /users/{handle}/followers，follow.UserItem 列表）与拉黑（PUT/DELETE block → {ok:true}）
    if (path.endsWith('/api/v1/users/' + handle + '/followers')) return { body: { data: [FOLLOWER], next_cursor: null } };
    if (path.endsWith('/api/v1/users/' + handle + '/block')) return { body: { data: { ok: true } } };
    if (path.endsWith('/api/v1/users/' + handle + '/titles')) return { body: TITLES };
    if (path.endsWith('/api/v1/users/' + handle + '/topics')) return { body: { data: [], next_cursor: null } };
    if (path.endsWith('/api/v1/users/' + handle + '/channels')) return { body: { data: [] } };
    if (path.endsWith('/api/v1/users/' + handle)) return { body: profile(CURRENT, handle, opts.cover) };
    if (path.endsWith('/api/v1/me/donation-settings')) {
      return { body: { data: { show_channels: true, records_public: false, notice_visible: true, notice_text: '' } } };
    }
    return { status: 404, body: { error: { code: 'common.not_found', message: '没有这条桩：' + path } } };
  });
}

// D18：本人主页的头衔**可点**，点开是「我持有的头衔 + 不佩戴」，选完调 PUT /me/title。
it('D18：本人点头衔 → 下拉（持有的头衔 + 不佩戴）→ 选中即 PUT /me/title', async () => {
  stubProfile({});
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
  stubProfile({});
  renderProfile('demo-admin');
  fireEvent.click(await screen.findByTestId('dropdown-trigger'));
  await screen.findByTestId('dropdown-content');
  fireEvent.click(screen.getByText('不佩戴'));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && (c.body as { title_id?: string }).title_id === '')).toBe(true));
});

// 别人主页：只显示、不可点 —— 连下拉触发器都不该存在（不是「点了没反应」）
it('D18：别人主页的头衔不可点（没有下拉触发器）', async () => {
  stubProfile({ me: false });
  renderProfile('demo-admin');
  // 这一页头衔出现两次（hero 的身份行 + 右栏「徽章」格），所以用 findAll —— 哪一处都不该变成下拉
  await screen.findAllByText('执政官');
  expect(screen.queryByTestId('dropdown-trigger')).toBeNull();
});

// D19：关注**用户**（后端 PUT/DELETE /users/{handle}/follow 一直在，前端此前零调用）。
// 态以服务端回执为准：桩会随 PUT/DELETE 变，所以「按钮上的字」只能来自回执，不能是本地翻转。
it('D19：别人主页有「关注」；点了 PUT /users/{handle}/follow，按钮按回执变「已关注」', async () => {
  stubProfile({ handle: 'demo-voidray' });
  renderProfile('demo-voidray');
  fireEvent.click(await screen.findByRole('button', { name: '关注' }));
  await waitFor(() => {
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/api/v1/users/demo-voidray/follow'))).toBe(true);
  });
  await screen.findByRole('button', { name: '已关注' });
});

// 已关注的再点一次 = 取关（DELETE，同一颗按钮）。幂等两端都在后端，前端只发对动词。
it('D19：已关注再点 → DELETE /users/{handle}/follow，回执说 false 就变回「关注」', async () => {
  stubProfile({ handle: 'demo-voidray', following: true });
  renderProfile('demo-voidray');
  fireEvent.click(await screen.findByRole('button', { name: '已关注' }));
  await waitFor(() => {
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/v1/users/demo-voidray/follow'))).toBe(true);
  });
  await screen.findByRole('button', { name: '关注' });
});

it('D19：自己看自己不显示关注（连一颗带「关注」字样的按钮都没有）', async () => {
  stubProfile({});
  renderProfile('demo-admin');
  // 本人主页的动作是「账号设置」（Ring 的 Button 带 href 就渲染成链接）；
  // 这一页有两处（hero 的动作 + 底部「不能发帖」提示里的那个），所以用 findAll
  await screen.findAllByRole('link', { name: '账号设置' });
  expect(screen.queryByRole('button', { name: /关注/ })).toBeNull();
});

it('D19：未登录看到的是去登录的引导（不是一颗点了没反应的按钮）', async () => {
  stubProfile({ me: false, handle: 'demo-voidray' });
  renderProfile('demo-voidray');
  const link = await screen.findByRole('link', { name: '登录后关注' });
  expect(link.getAttribute('href') ?? '').toContain('login');
});

// D23：裁剪只在本人主页存在 —— 看别人时连**上传通道本身**都不该在 DOM 里。
// （先证明它会红：不挂 isSelf 那层时，这一页的 headless 上传器仍然渲染出一个 file input，
//  而它背后是 POST /me/avatar —— 别人的主页上留着一条通往上传播的通道。）
it('D23：别人主页没有头像上传通道（连 file input 都不在 DOM 里）', async () => {
  stubProfile({ me: false, handle: 'demo-voidray' });
  const { container } = renderProfile('demo-voidray');
  await screen.findByText('示范管理员');
  expect(container.querySelectorAll('input[type=file]')).toHaveLength(0);
  expect(screen.queryByTestId('avatar-upload-entry')).toBeNull();
});

// D58（生产裂图）：cover 是后端下发的 /img/<hash>，此前被 assetUrl 拼成 /art/img/<hash> ——
// 无文件无扩展名 → SPA 回落 index.html（200, text/html）→ <img> 拿到 HTML 解码失败 = 裂图。
// 钉住：hero 壁纸的 <img> 原样用 /img/ 前缀，绝不出现 /art/img/。
it('D58：有封面时 hero 壁纸 img 直接用 /img/<hash>（不再拼 art/）', async () => {
  stubProfile({ cover: '/img/bbaf40a7feed' });
  const { container } = renderProfile('demo-admin');
  await screen.findByText('示范管理员');
  expect(container.querySelector('img[src^="/img/bbaf40a7feed"]')).toBeTruthy();
  expect(container.querySelector('img[src^="/art/img/"]')).toBeNull();
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

// 关注者（GET /users/{handle}/followers，公开读）：主页右栏那一格原来写的是「本产品没有关注关系」，
// L5 之后那句话已经是假的 —— 端点在、只是没人调。
it('关注者：GET /users/{handle}/followers 渲染在主页右栏，链回各自主页', async () => {
  stubProfile({ handle: 'demo-voidray' });
  renderProfile('demo-voidray');
  await screen.findByTestId('profile-followers');
  const link = await screen.findByRole('link', { name: /工蜂/ });
  expect(link.getAttribute('href')).toBe('/u/demo-drone');
});

// 拉黑（PUT/DELETE /users/{handle}/block，真源 forum/internal/forum/votes.go:190）：
// 它改的是**关系**，所以落在主页动作条（关注 / 私信 / 举报 那一排）。
// 后端**没有读拉黑状态的端点**，所以按钮的态只能来自动作回执 —— 这一条盯的就是「先确认、再发、发完换态」。
it('拉黑：动作条「拉黑」→ 确认弹层 → PUT /users/{handle}/block；成功后可「解除拉黑」发 DELETE', async () => {
  stubProfile({ handle: 'demo-voidray' });
  renderProfile('demo-voidray');
  const btn = await screen.findByTestId('profile-block');
  expect(btn.textContent).toContain('拉黑');

  fireEvent.click(btn);
  const dialog = await screen.findByRole('dialog');
  // 打开弹层 ≠ 已经拉黑：没点确认之前一个 PUT 都不许发
  expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: '拉黑' }));
  await waitFor(() => {
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/api/v1/users/demo-voidray/block'))).toBe(true);
  });
  await waitFor(() => expect(screen.getByTestId('profile-block').textContent).toContain('解除拉黑'));

  // 解除拉黑不再问第二遍（它只是把限制撤掉），直接 DELETE
  fireEvent.click(screen.getByTestId('profile-block'));
  await waitFor(() => {
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/v1/users/demo-voidray/block'))).toBe(true);
  });
  await waitFor(() => expect(screen.getByTestId('profile-block').textContent).not.toContain('解除'));
});

// 拉黑自己不是校验失败、是请求本身没意义（后端 votes.go:201「不能拉黑自己」）——本人主页连这颗按钮都不画。
it('拉黑：本人主页没有拉黑按钮', async () => {
  stubProfile({});
  renderProfile('demo-admin');
  await screen.findByText('示范管理员');
  expect(screen.queryByTestId('profile-block')).toBeNull();
});
