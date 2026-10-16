import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GrantTitleDialog } from './users-dialogs';
import { revokeTitle, type AdminUser, type Title } from '@/lib/api/admin';

// D72：管理端**撤销**用户头衔在界面上根本没有入口 —— revokeTitle 与 DELETE
// /admin/users/{id}/titles/{titleId}（title/handler.go:42，回执 204 空）早就有，缺的就是这颗按钮。
// 用例钉住三件事：弹层里能看到已持有的头衔（公共读 GET /users/{handle}/titles，handle= username）、
// 点「撤销」真的上送那对 id、成功后清单就地少一行（弹层自己失效 qk.userTitles，容器不必知道 handle）。
afterEach(() => {
  vi.unstubAllGlobals();
});

function user(over: Partial<AdminUser>): AdminUser {
  return {
    id: 'u-1', username: 'waiting', nickname: '等激活的人', email: 'w@example.com',
    role: { key: 'user', name: '普通用户', badge_color: '' },
    status: 'active', email_verified_at: null, activated_at: null,
    trusted: false, level: 0,
    created_at: '2026-10-14T10:00:00Z', last_login_at: null, topic_count: 0, reply_count: 0,
    ...over,
  };
}

const title = (over: Partial<Title>): Title => ({
  id: 't-1', key: 'gold', name: '金牌作者', color: '#c8a02c', description: '', archived_at: null, ...over,
});

const JSON_HEADERS = { 'content-type': 'application/json' };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });

function renderDialog() {
  // 弹层自己吃 react-query（持有清单 + 成功后失效重拉），测试要包一层 Provider；
  // onRevoke 用**真的** revokeTitle：这一对 id 确实变成 admin 上的 DELETE（不是屏内自话）。
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <GrantTitleDialog
        user={user({})}
        titles={[]}
        onClose={() => {}}
        onGrant={() => {}}
        onRevoke={(userId, titleId) => revokeTitle(userId, titleId)}
      />
    </QueryClientProvider>,
  );
}

it('D72：已持头衔列进弹层；点「撤销」→ DELETE /admin/users/{id}/titles/{titleId}，回执落地后清单少一行', async () => {
  let held: Title[] = [title({}), title({ id: 't-2', key: 'silver', name: '银牌作者' })];
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url: u, method });
    if (u.includes('/users/waiting/titles')) {
      return ok({ data: { items: held, equipped_id: '' } });
    }
    if (method === 'DELETE' && u.includes('/admin/users/u-1/titles/t-1')) {
      held = held.filter((t) => t.id !== 't-1');
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ error: { code: 'common.not_found', message: 'no' } }), { status: 404, headers: JSON_HEADERS });
  }));
  renderDialog();
  await waitFor(() => expect(screen.getByText('金牌作者')).toBeTruthy());

  const revoke = screen.getByTestId('title-revoke-t-1');
  revoke.click();

  await waitFor(() => {
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/admin/users/u-1/titles/t-1'))).toBe(true);
  });
  // 失效重拉：服务端已少一行，屏上的持有清单跟着少一行（另一颗原样保留）
  await waitFor(() => expect(screen.queryByText('金牌作者')).toBeNull());
  expect(screen.getByText('银牌作者')).toBeTruthy();
});
