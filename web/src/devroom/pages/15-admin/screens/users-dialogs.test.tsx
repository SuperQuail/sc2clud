import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TitleEditDialog } from './users-dialogs';
import { grantTitle, revokeTitle, type AdminUser, type Title } from '@/lib/api/admin';

// 头衔编辑（D72 撤销入口的后继）：弹层是**一列复选框**，勾上 = 授予、取消勾 = 撤销，
// 立即生效、没有保存按钮。用例钉住四件事：
//  ① 行集合 = 目录里未归档的 ∪ 该用户已持有的（并集：持有已归档头衔的人得能取消它，而归档的不能新发）；
//  ② 点未勾选的行 → POST /admin/users/{id}/titles/{titleId}；
//  ③ 取消勾选 → DELETE 同路径；④ 失败就地报错且**不做乐观翻转**（勾选态留在服务端真值）。
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

/** 假的头衔域：公共读持有清单 + 管理端那一对写端点（204），并记下每一次调用。
 *  fail='titleId:METHOD' 让那一次回 403（用来演失败时勾选态该怎么站）。 */
function fakeApi(opts: { catalog?: Title[]; held: Title[]; equipped?: string; fail?: string }) {
  const pool = new Map<string, Title>([...(opts.catalog ?? []), ...opts.held].map((t) => [t.id, t]));
  const state = { held: [...opts.held], calls: [] as Array<{ url: string; method: string }> };
  const cached = () => ({ data: { items: state.held, equipped_id: opts.equipped ?? '' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    state.calls.push({ url, method });
    if (method === 'GET' && url.includes('/users/waiting/titles')) return ok(cached());
    const m = /\/admin\/users\/u-1\/titles\/([^/?]+)/.exec(url);
    if (m) {
      const id = m[1]!;
      if (opts.fail === id + ':' + method) {
        return new Response(JSON.stringify({ error: { code: 'common.forbidden', message: '不允许' } }), { status: 403, headers: JSON_HEADERS });
      }
      if (method === 'POST') { const t = pool.get(id); if (t) state.held = [...state.held, t]; return new Response(null, { status: 204 }); }
      if (method === 'DELETE') { state.held = state.held.filter((t) => t.id !== id); return new Response(null, { status: 204 }); }
    }
    return new Response(JSON.stringify({ error: { code: 'common.not_found', message: 'no' } }), { status: 404, headers: JSON_HEADERS });
  }));
  return state;
}

const heldReads = (calls: Array<{ url: string; method: string }>) =>
  calls.filter((c) => c.method === 'GET' && c.url.includes('/users/waiting/titles')).length;

/** onSet 用**真的** admin api：勾选这一下确实变成 POST/DELETE（不是屏内自话）。 */
function renderDialog(opts: { catalog?: Title[]; held: Title[]; equipped?: string; fail?: string }) {
  const state = fakeApi(opts);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TitleEditDialog
        user={user({})}
        titles={opts.catalog ?? []}
        onClose={() => {}}
        onSet={(userId, titleId, held) => (held ? grantTitle(userId, titleId) : revokeTitle(userId, titleId))}
      />
    </QueryClientProvider>,
  );
  return state;
}

const box = (re: RegExp) => screen.getByRole('checkbox', { name: re }) as HTMLInputElement;
const findBox = async (re: RegExp) => (await screen.findByRole('checkbox', { name: re })) as HTMLInputElement;

it('一列复选框 = 目录里未归档的 ∪ 已持有的；持有的勾上，佩戴中与已归档各有标注', async () => {
  renderDialog({
    catalog: [
      title({}),
      title({ id: 't-3', key: 'bronze', name: '铜牌作者' }),
      title({ id: 't-9', key: 'retired', name: '退役头衔', archived_at: '2026-01-01T00:00:00Z' }),
    ],
    held: [title({}), title({ id: 't-2', key: 'silver', name: '银牌作者', archived_at: '2026-02-02T00:00:00Z' })],
    equipped: 't-1',
  });
  expect((await findBox(/金牌作者/)).checked).toBe(true); // 持有 → 勾上
  expect(box(/铜牌作者/).checked).toBe(false); // 没持有 → 没勾
  expect(box(/银牌作者/).checked).toBe(true); // 持有但已归档：仍在列（撤得掉），并标归档
  expect(screen.getByText('已归档')).toBeTruthy();
  expect(screen.getByText('佩戴中')).toBeTruthy();
  // 目录里归档、且他没持有的：只能取消不能新发 → 不出现
  expect(screen.queryByRole('checkbox', { name: /退役头衔/ })).toBeNull();
});

it('点未勾选的行 → POST /admin/users/{id}/titles/{titleId}；失效重拉后勾选态按服务端真值回填', async () => {
  const state = renderDialog({ catalog: [title({ id: 't-3', key: 'bronze', name: '铜牌作者' })], held: [] });
  const bronze = await findBox(/铜牌作者/);
  expect(bronze.checked).toBe(false);
  fireEvent.click(bronze);

  await waitFor(() => expect(state.calls.some((c) => c.method === 'POST' && c.url.includes('/admin/users/u-1/titles/t-3'))).toBe(true));
  // 弹层自己失效 qk.userTitles（handle 只有它知道）→ 再读一次持有清单，勾上
  await waitFor(() => expect(heldReads(state.calls)).toBe(2));
  expect(box(/铜牌作者/).checked).toBe(true);
});

it('取消勾选 → DELETE 同路径；行留在列里（目录里还有它），只是不再勾上', async () => {
  const state = renderDialog({ catalog: [title({})], held: [title({})], equipped: 't-1' });
  const gold = await findBox(/金牌作者/);
  expect(gold.checked).toBe(true);
  fireEvent.click(gold);

  await waitFor(() => expect(state.calls.some((c) => c.method === 'DELETE' && c.url.includes('/admin/users/u-1/titles/t-1'))).toBe(true));
  await waitFor(() => expect(heldReads(state.calls)).toBe(2));
  expect(box(/金牌作者/).checked).toBe(false);
});

it('失败：就地报错、勾选态留在服务端真值（不做乐观翻转，也不失效缓存）', async () => {
  const state = renderDialog({
    catalog: [title({}), title({ id: 't-3', key: 'bronze', name: '铜牌作者' })],
    held: [title({})],
    equipped: 't-1',
    fail: 't-1:DELETE',
  });
  const gold = await findBox(/金牌作者/);
  fireEvent.click(gold);

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('不允许');
  expect(box(/金牌作者/).checked).toBe(true); // 没被勾掉：真值仍是「持有」
  expect(heldReads(state.calls)).toBe(1); // 失败不失效缓存，勾选态不拿假状态盖真值
});
