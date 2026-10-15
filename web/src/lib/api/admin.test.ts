import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUsers } from './admin';
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
