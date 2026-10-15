import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminSetUserPassword, fetchUsers } from './admin';
import { mockFetch } from '@/test/fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
});

// 用户屏「只显示 20 人、看不到总人数」的根因在客户端这一层：
// 旧 fetchUsers 只回 {items,next}，屏上拿不到总数，也没有任何东西能把游标带回去翻页。
// 所以这一份钉三件事：v=2、counts 被解出来、游标跟着请求走。
describe('用户列表请求（FIX-USERS）', () => {
  const counts = { total: 137, banned: 4, pending_activation: 9, email_unverified: 12 };

  it('走 v=2 包络（总数只有它有），并把 counts 原样解出来', async () => {
    const { calls } = mockFetch([{ body: { data: [], next_cursor: null, counts } }]);
    const out = await fetchUsers({});
    expect(calls[0]?.url).toContain('v=2');
    expect(out.counts).toEqual(counts);
  });

  it('游标进请求：翻页靠 cursor，不是页码', async () => {
    const { calls } = mockFetch([{ body: { data: [], next_cursor: 'cur-2', counts } }]);
    const out = await fetchUsers({ cursor: 'cur-1' });
    expect(calls[0]?.url).toContain('cursor=cur-1');
    // next 不能被吃掉（吃掉了「下一页」就永远到底）
    expect(out.next).toBe('cur-2');
  });

  it('服务端没给 counts 时不假装有总数（0 而不是本页条数）', async () => {
    mockFetch([{ body: { data: [{ id: 'u1' }], next_cursor: null } }]);
    const out = await fetchUsers({});
    expect(out.items).toHaveLength(1);
    expect(out.counts.total).toBe(0);
  });
});

// D56 管理员重置密码：password 空串 = 后端走「生成」，响应只在生成时给密码
describe('D56 重置密码请求', () => {
  it('POST /admin/users/{id}/password；不传密码时 body.password 是空串', async () => {
    // httpx.OK 的包络是 {ok, data}：client 的 api() 解的就是 data
    const { calls } = mockFetch([{ body: { data: { password: 'k7rqmzt39v4h', revoked: 3 } } }]);
    const out = await adminSetUserPassword('u-1');
    expect(calls[0]?.url).toContain('/admin/users/u-1/password');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ password: '' });
    expect(out.password).toBe('k7rqmzt39v4h');
    expect(out.revoked).toBe(3);
  });

  it('显式密码随 body 原文发送；响应不给 password', async () => {
    const { calls } = mockFetch([{ body: { data: { revoked: 5 } } }]);
    const out = await adminSetUserPassword('u-2', 'admin-set-2026');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ password: 'admin-set-2026' });
    expect(out.password).toBeUndefined();
    expect(out.revoked).toBe(5);
  });
});
