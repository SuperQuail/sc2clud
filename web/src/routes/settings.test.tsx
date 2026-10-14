import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    if (url.includes('/me')) return { body: ME };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderSettings();

  await waitFor(() => expect(screen.getByTestId('notice-settings')).toBeTruthy());
  // 设计稿里那个「仅关注的人」不该出现 —— 库里的 CHECK 就把它删了（本产品没有关注关系）
  expect(screen.queryByText('仅关注的人')).toBeNull();
  expect(screen.getByText('@ 我的消息提醒')).toBeTruthy();

  // 「点赞提醒」那一行的开关：打开它
  const toggles = screen.getAllByRole('checkbox') as HTMLInputElement[];
  const likeToggle = toggles.at(-1)!;
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
    if (url.includes('/me')) return { body: ME };
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
    if (url.includes('/me')) return { body: ME };
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
