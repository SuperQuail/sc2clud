import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminArchiveIssue, adminRestoreIssue, fetchAdminIssues, type IssueAdmin } from './admin-issues';
import { mockFetch } from '@/test/fetch-mock';

// 「Issue 管理」屏的客户端那一半（契约见 Lead 冻结的接口，2026-10-16）：
//   · 列表 GET /admin/issues?archived=0|1|all&status=open|closed&kind=&q=&limit=&cursor=
//   · 归档 POST /admin/issues/{id}/archive {reason}、恢复 POST /admin/issues/{id}/restore
// 这里钉的是**发出的请求**（URL / 方法 / 体），不是屏：屏只负责把筛选变成 params。

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 取查询串里的一个参数（断言与顺序无关：参数顺序不是契约，值才是）。
 *  给一个基址是因为 api() 发出的是**相对路径**（/api/v1/admin/issues?...），new URL 单参数吃不下它。 */
function q(url: string, key: string): string | null {
  return new URL(url, 'http://localhost').searchParams.get(key);
}

describe('管理端 Issue 列表', () => {
  it('筛选进 query：archived / status / kind / q；游标与 limit 沿用列表包络', async () => {
    const { calls } = mockFetch([{ body: { data: [], next_cursor: 'cur-2' } }]);
    const out = await fetchAdminIssues({ archived: '1', status: 'closed', kind: 'bug', q: '爱兰', cursor: 'cur-1' });

    expect(calls[0]?.url).toContain('/admin/issues');
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
    expect(q(calls[0]!.url, 'archived')).toBe('1');
    expect(q(calls[0]!.url, 'status')).toBe('closed');
    expect(q(calls[0]!.url, 'kind')).toBe('bug');
    expect(q(calls[0]!.url, 'q')).toBe('爱兰');
    expect(q(calls[0]!.url, 'cursor')).toBe('cur-1');
    expect(q(calls[0]!.url, 'limit')).toBe('20');
    // next_cursor 在 data 外面，不能被吃掉（吃掉了「下一页」永远到底）
    expect(out.next).toBe('cur-2');
  });

  it('不选的档位不进 query（archived=all 是唯一要显式发的「全部」）', async () => {
    const { calls } = mockFetch([{ body: { data: [], next_cursor: null } }]);
    await fetchAdminIssues({ archived: 'all', q: '  ' });
    expect(q(calls[0]!.url, 'archived')).toBe('all');
    expect(q(calls[0]!.url, 'status')).toBeNull();
    expect(q(calls[0]!.url, 'kind')).toBeNull();
    expect(q(calls[0]!.url, 'q')).toBeNull();
    expect(q(calls[0]!.url, 'cursor')).toBeNull();
  });

  it('DTO 字段名照契约小写下划线解出来（body_html / archived_at / archived_by / topic）', async () => {
    const row: IssueAdmin = {
      id: '01a13540-ff54-7f07-a975-51e08a5f831c',
      number: 42,
      kind: 'bug',
      title: '触发器里 Wait 之后变量被清空',
      body_html: '<p>正文</p>',
      status: 'keep_open',
      tags: ['触发器'],
      created_at: '2026-10-14T10:00:00Z',
      updated_at: '2026-10-15T10:00:00Z',
      archived_at: null,
      archived_by: null,
      archive_reason: '',
      author: { handle: 'alice', nickname: '爱丽丝', avatar_hash: 'a1b2c3' },
      topic: { id: '11111111-1111-1111-1111-111111111111', title: '教程合集' },
    };
    mockFetch([{ body: { data: [row], next_cursor: null } }]);
    const out = await fetchAdminIssues({ archived: '0' });
    expect(out.items[0]?.body_html).toBe('<p>正文</p>');
    expect(out.items[0]?.status).toBe('keep_open');
    expect(out.items[0]?.archived_at).toBeNull();
    expect(out.items[0]?.archived_by).toBeNull();
    expect(out.items[0]?.topic.title).toBe('教程合集');
    expect(out.items[0]?.author.avatar_hash).toBe('a1b2c3');
  });
});

describe('管理端 Issue 归档 / 恢复', () => {
  it('归档：POST /admin/issues/{id}/archive，reason 进 body（空串也发，后端收可空）', async () => {
    const { calls } = mockFetch([{ body: { data: { ok: true } } }]);
    const out = await adminArchiveIssue('01a13540-ff54-7f07-a975-51e08a5f831c', '重复反馈');
    expect(calls[0]?.url).toContain('/admin/issues/01a13540-ff54-7f07-a975-51e08a5f831c/archive');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ reason: '重复反馈' });
    expect(out.ok).toBe(true);
  });

  it('恢复：POST /admin/issues/{id}/restore，无 body', async () => {
    const { calls } = mockFetch([{ body: { data: { ok: true } } }]);
    await adminRestoreIssue('01a13540-ff54-7f07-a975-51e08a5f831c');
    expect(calls[0]?.url).toContain('/admin/issues/01a13540-ff54-7f07-a975-51e08a5f831c/restore');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
  });
});
