import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { SettingsPage } from './settings';

// 设置页的两个房子件（DevRoom 11-profile 的 AccountPanel + ui/message 的 NoticeSettings）在**真页面**里：
// 这里只换网络边界，断言的是「发出去的请求」与「本地假口令绝不能算数」。
// 契约真源：forum/internal/notify/handler.go 的 noticeSettingDTO（alert / reply_scope / mention_scope / like_alert）
// 与 auth 的 changePasswordBody（old_password / new_password）。
afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { status?: number; body?: unknown };
const calls: Array<{ url: string; method: string; body: unknown }> = [];
function mockApi(byPath: (url: string) => Reply) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply = byPath(u);
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
    bio: '战役作者',
    email_verified: true,
    perms: ['topic.create'],
    is_super: false,
    role: { key: 'admin', name: '管理员' },
  },
};
// 逐字照后端 noticeSettingDTO
const NOTICE = { data: { alert: true, reply_scope: 'all', mention_scope: 'none', like_alert: false } };

function renderSettings() {
  return render(
    <Providers>
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsPage />
      </MemoryRouter>
    </Providers>,
  );
}

it('消息提醒四行来自后端：两档值域只有 all/none，改一行发的是 PUT 全量四字段', async () => {
  mockApi((url) => {
    if (url.includes('/notifications/settings')) return { body: NOTICE };
    if (url.endsWith('/api/v1/me')) return { body: ME };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderSettings();

  await waitFor(() => expect(screen.getByTestId('notice-settings')).toBeTruthy());
  // 设计稿里那个「仅关注的人」不该出现 —— 库里的 CHECK 就把它删了（本产品没有关注关系）
  expect(screen.queryByText('仅关注的人')).toBeNull();
  expect(screen.getByText('@ 我的消息提醒')).toBeTruthy();

  // 「点赞提醒」那一行的开关：打开它。
  // **按文案找，不按序号**：原先写的是 `getAllByRole('checkbox').at(-1)` —— 那等于断言
  // 「这一屏最后一个 checkbox 就是它」，而 2026-10-14 加的「赞赏与收款码」一节正好排在它后面，
  // 于是这条用例静默地点了**另一个开关**、PUT 一次都没发（消息提醒这一块就再没人验了）。
  const likeToggle = screen
    .getByText('点赞提醒')
    .closest('section')!
    .querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(likeToggle.checked).toBe(false);
  act(() => likeToggle.click());

  await waitFor(() => {
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/notifications/settings'));
    expect(put).toBeTruthy();
    // 全量四字段（表就四列，没有半更新语义）
    expect(put!.body).toEqual({ alert: true, reply_scope: 'all', mention_scope: 'none', like_alert: true });
  });
});

it('改密码：不存在的本地演示口令**不能**算成功；提交发的是 POST /me/password 的 old_password/new_password', async () => {
  mockApi((url) => {
    if (url.includes('/notifications/settings')) return { body: NOTICE };
    if (url.includes('/me/password')) return { body: { data: null } };
    if (url.endsWith('/api/v1/me')) return { body: ME };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  const { container } = renderSettings();
  await waitFor(() => expect(screen.getByTestId('password-save')).toBeTruthy());

  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=password]'));
  expect(inputs.length).toBe(3);
  const [current, next, repeat] = inputs;

  // 本地两条拦截照旧：两次不一致
  act(() => {
    fireEvent.change(current!, { target: { value: 'sc2clud' } });
    fireEvent.change(next!, { target: { value: 'newpass123' } });
    fireEvent.change(repeat!, { target: { value: 'newpass124' } });
  });
  act(() => screen.getByTestId('password-save').click());
  expect(screen.getByText(/不一样/)).toBeTruthy();
  expect(calls.some((c) => c.url.includes('/me/password'))).toBe(false);

  // 两次一致：**房间里的演示口令 sc2clud 在真站上不是一个通过条件** —— 直接发请求，成功态等后端
  act(() => fireEvent.change(repeat!, { target: { value: 'newpass123' } }));
  act(() => screen.getByTestId('password-save').click());
  await waitFor(() => {
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/me/password'));
    expect(post).toBeTruthy();
    expect(post!.body).toEqual({ old_password: 'sc2clud', new_password: 'newpass123' });
  });
});

it('服务端说「当前密码不对」时，那句话来自 fields.old_password（本地判不出来）', async () => {
  mockApi((url) => {
    if (url.includes('/me/password')) {
      return {
        status: 400,
        body: { error: { code: 'common.invalid_input', message: '参数有误', fields: { old_password: '当前密码不对' } } },
      };
    }
    if (url.includes('/notifications/settings')) return { body: NOTICE };
    if (url.endsWith('/api/v1/me')) return { body: ME };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  const { container } = renderSettings();
  await waitFor(() => expect(screen.getByTestId('password-save')).toBeTruthy());
  const [current, next, repeat] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=password]'));
  act(() => {
    fireEvent.change(current!, { target: { value: 'wrong-one' } });
    fireEvent.change(next!, { target: { value: 'newpass123' } });
    fireEvent.change(repeat!, { target: { value: 'newpass123' } });
  });
  act(() => screen.getByTestId('password-save').click());

  await waitFor(() => expect(screen.getByText('当前密码不对')).toBeTruthy());
  // 失败时**不能**显示成功态（房间里的本地判定在真站会被拿掉）
  expect(screen.queryByTestId('password-done')).toBeNull();
});

// 用户原话（D75）：退出登录应该在个人设置页**最下面**并且按钮**标红**。
// 旧行为它塞在 AccountPanel（页面中部）里，而且没有 settings-logout 这一颗 —— 前两条必红。
it('D75：退出登录搬到页底区块，AccountPanel 里不再有原退出按钮；点击打到 POST /auth/logout', async () => {
  mockApi((url) => {
    if (url.includes('/notifications/settings')) return { body: NOTICE };
    if (url.endsWith('/api/v1/me')) return { body: ME };
    if (url.includes('/auth/logout')) return { body: { data: null } };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderSettings();
  await waitFor(() => expect(screen.getByTestId('settings-logout')).toBeTruthy());
  // 「最下面」是结构事实：承载它的块是设置页根容器的**最后一个**直接子元素（打赏记录那节已在它前面）。
  // Footer 是设置页专用标签，靠它定位就不碰其它 section 的顺序。
  const footer = screen.getByTestId('settings-logout').closest('footer')!;
  expect(footer.parentElement!.lastElementChild).toBe(footer);
  // AccountPanel 区域（onLogout 不再传）不再渲染它原来那颗退出按钮
  expect(screen.queryByTestId('logout')).toBeNull();

  fireEvent.click(screen.getByTestId('settings-logout'));
  await waitFor(() => {
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/auth/logout'));
    expect(post).toBeTruthy();
  });
});

// ── 登录设备（GET /me/sessions + DELETE /me/sessions/{id}）────────────────────
// 契约真源：forum/internal/auth/service.go:235 的 SessionItem ——
// id / ip / user_agent / last_seen_at / created_at / is_current（**不回 token / token_hash**）。
// 撤销是**不可撤销**的动作（那台设备上的登录立刻失效、要重新登录），所以先出确认弹层再发 DELETE。
const SESSIONS = [
  { id: 's-1', ip: '203.0.113.7', user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', last_seen_at: '2026-10-16T03:50:00Z', created_at: '2026-10-01T00:00:00Z', is_current: true },
  { id: 's-2', ip: '198.51.100.9', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1', last_seen_at: '2026-10-15T10:00:00Z', created_at: '2026-10-02T00:00:00Z', is_current: false },
];

it('登录设备：GET /me/sessions 列出设备与「当前设备」，退出另一台要二次确认，确认后才发 DELETE /me/sessions/{id}', async () => {
  let rows = SESSIONS;
  mockApi((url) => {
    if (url.endsWith('/api/v1/me/sessions/s-2')) {
      rows = rows.filter((s) => s.id !== 's-2');
      return { status: 204 };
    }
    if (url.endsWith('/api/v1/me/sessions')) return { body: { data: rows } };
    if (url.endsWith('/api/v1/me')) return { body: ME };
    if (url.includes('/notifications/settings')) return { body: NOTICE };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderSettings();

  // 设备 / IP / 最后活跃 / 是否当前 —— 四样都在（IP 与「最后活跃」同一行同一段文本，所以按正则找）
  await screen.findByText(/203\.0\.113\.7/);
  expect(screen.getByText(/198\.51\.100\.9/)).toBeTruthy();
  expect(screen.getByText(/Chrome\/120/)).toBeTruthy();
  expect(screen.getAllByText('当前设备')).toHaveLength(1);

  fireEvent.click(screen.getByTestId('session-revoke-s-2'));
  const dialog = await screen.findByRole('dialog');
  // 「不可撤销」这一句必须在确认里说清（那台设备要重新登录）
  expect(dialog.textContent).toContain('重新登录');
  // 打开弹层 ≠ 已经退出：没点确认之前一个 DELETE 都不许发
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

  fireEvent.click(within(dialog).getByRole('button', { name: '退出该设备' }));
  await waitFor(() => {
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url.endsWith('/api/v1/me/sessions/s-2')).toBe(true);
  });
  // 204 之后这一格重拉：退出掉的那一行不再出现
  await waitFor(() => expect(screen.queryByText(/198\.51\.100\.9/)).toBeNull());
});

it('登录设备：退出当前这一台时，确认里要说清「本页会变成未登录」', async () => {
  mockApi((url) => {
    if (url.endsWith('/api/v1/me/sessions')) return { body: { data: SESSIONS } };
    if (url.endsWith('/api/v1/me')) return { body: ME };
    if (url.includes('/notifications/settings')) return { body: NOTICE };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderSettings();
  await screen.findByText(/203\.0\.113\.7/);

  fireEvent.click(screen.getByTestId('session-revoke-s-1'));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('当前正在用');
});

// ── 「我关注的」（GET /me/following/boards + GET /me/following/users）─────────
// 落点理由：这两条是 /me/* 的账号私域（谁关注了谁只对自己有意义），
// 而个人主页是**任何人都能看的公开页**（/u/{handle}），把「我关注的」挂在那种页面上要额外分一个 isSelf 支路；
// 设置页本身就是「我的账号」的汇总屏（设备 / 提醒 / 赞赏 / 会话都在这），接线门禁的落地屏建议也是它。
it('「我关注的」：GET /me/following/boards 与 GET /me/following/users 两条列表都渲染，并链回分区页 / 主页', async () => {
  mockApi((url) => {
    if (url.endsWith('/api/v1/me/sessions')) return { body: { data: [] } };
    if (url.includes('/api/v1/me/following/boards')) {
      return { body: { data: [{ slug: 'custom-campaign', name: '自制战役', description: '玩家自制战役', cover_hash: '', followed_at: '2026-10-10T00:00:00Z' }], next_cursor: null } };
    }
    if (url.includes('/api/v1/me/following/users')) {
      return { body: { data: [{ id: 'u-9', handle: 'demo-drone', nickname: '工蜂', avatar_hash: '', avatar_small_hash: '', followed_at: '2026-10-11T00:00:00Z' }], next_cursor: null } };
    }
    if (url.endsWith('/api/v1/me')) return { body: ME };
    if (url.includes('/notifications/settings')) return { body: NOTICE };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderSettings();

  const board = await screen.findByRole('link', { name: /自制战役/ });
  expect(board.getAttribute('href')).toBe('/b/custom-campaign');
  const user = await screen.findByRole('link', { name: /工蜂/ });
  expect(user.getAttribute('href')).toBe('/u/demo-drone');
});
