import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { NoticeCenter } from './messages';

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

/** 网络边界：记下每个列表请求的 URL，答什么由 byKind 决定（后端按 kind 过滤，桩也按 kind 过滤）。 */
function mockApi() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const body = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('/api/v1/me')) return body(ME);
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

it('旧书签的单值 ?kind=review 落到「系统通知」这一档（不显示成「回复我的」）', async () => {
  const calls = mockApi();
  renderCenter('/notifications?kind=review');
  expect(await screen.findByText(/你被禁言 3 天/)).toBeTruthy();
  // 归一成多值再问后端，界面上的档位名也是「系统通知」
  expect(calls.some((u) => new URL(u, 'http://x').searchParams.get('kind') === 'system,review,sanction,reward')).toBe(true);
  // Ring 的 Button 没有 aria-pressed，选中态是类名
  expect(screen.getByTestId('notice-nav-kind:system,review,sanction,reward').className).toContain('ring-button-active');
});
