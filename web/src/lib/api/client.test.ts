import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { ApiError, apiErrorLine, uiActionFor } from './errors';
import { mockFetch } from '@/test/fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('解包 data 并带上 Cookie', async () => {
    const { calls } = mockFetch([{ body: { data: { id: 'x' } } }]);
    await expect(api<{ id: string }>('/me')).resolves.toEqual({ id: 'x' });
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.url).toBe('/api/v1/me');
  });

  it('把查询参数拼进 URL，忽略 undefined', async () => {
    const { calls } = mockFetch([{ body: { data: [] } }]);
    await api('/topics', { query: { limit: 20, cursor: undefined } });
    expect(calls[0]?.url).toBe('/api/v1/topics?limit=20');
  });

  it('探针走不带前缀的 base', async () => {
    const { calls } = mockFetch([{ body: { data: { status: 'ok', version: '0.1.0' } } }]);
    await api('/healthz', { base: '' });
    expect(calls[0]?.url).toBe('/healthz');
  });

  it('错误响应转成 ApiError，保留 code / request_id / fields', async () => {
    mockFetch([
      {
        status: 400,
        body: { error: { code: 'common.invalid_input', message: '参数错误', request_id: 'r1', fields: { title: '太短' } } },
      },
    ]);
    const err = await api('/topics', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('common.invalid_input');
    expect(apiErr.requestId).toBe('r1');
    expect(apiErr.fields?.title).toBe('太短');
    expect(uiActionFor(apiErr)).toBe('form');
  });

  it('401 的 UI 行为是弹登录，不是整页报错', async () => {
    mockFetch([{ status: 401, body: { error: { code: 'common.unauthorized', message: '请先登录' } } }]);
    const err = (await api('/me').catch((e: unknown) => e)) as ApiError;
    expect(uiActionFor(err)).toBe('login');
  });

  it('429 带上 Retry-After', async () => {
    mockFetch([
      { status: 429, headers: { 'retry-after': '30' }, body: { error: { code: 'common.rate_limited', message: '太快了' } } },
    ]);
    const err = (await api('/topics', { method: 'POST', body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfterMs).toBe(30_000);
    expect(uiActionFor(err)).toBe('retry');
  });

  it('网络故障是 status 0，而不是 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    const err = (await api('/me').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.code).toBe('network');
  });

  it('后端 message 是空串时给兜底原因，界面不会只剩编号（D70）', async () => {
    mockFetch([{ status: 500, body: { error: { code: 'common.internal', message: '', request_id: 'r9' } } }]);
    const err = (await api('/topics').catch((e: unknown) => e)) as ApiError;
    expect(err.message.trim()).not.toBe('');
    const line = apiErrorLine(err);
    expect(line).toContain('服务器错误');
    expect(line.endsWith('（错误编号 r9）')).toBe(true);
  });

  it('后端连 message 都没给时按状态兜底（code 也陌生）', async () => {
    mockFetch([{ status: 502, body: { error: { code: 'weird.code' } } }]);
    const err = (await api('/topics').catch((e: unknown) => e)) as ApiError;
    expect(err.message.trim()).not.toBe('');
    expect(apiErrorLine(err)).toContain('服务器错误');
  });

  it('204 返回 undefined', async () => {
    mockFetch([{ status: 204 }]);
    await expect(api('/notifications/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
