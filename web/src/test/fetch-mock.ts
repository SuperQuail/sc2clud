import { vi } from 'vitest';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

// 测试用的 fetch 桩：只替换网络边界，不 mock 被测组件（前端方案 §11）
export function mockFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies[i++] ?? { status: 500 };
    const status = reply.status ?? 200;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}
