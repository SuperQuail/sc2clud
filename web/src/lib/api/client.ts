import { BASE } from '@/lib/base';
import { ApiError } from './errors';

// 全站唯一的 fetch 出口（前端方案 §4.1 / §5）。其它任何文件出现 fetch( 都由 ESLint 拦住。
// 前缀来自 <base href>，所以同一份产物在 / 与 /dev/ 下都指向自己那个实例的后端
const DEFAULT_BASE = BASE + 'api/v1';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type Req = {
  method?: Method;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  base?: string; // 探针类接口不带 /api/v1 前缀时传 ''
};

function buildUrl(path: string, base: string, query?: Req['query']): string {
  const url = base + path;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? url + '?' + qs : url;
}

type ErrorBody = { error?: { code?: string; message?: string; request_id?: string; fields?: Record<string, string> } };

export async function api<T>(path: string, req: Req = {}): Promise<T> {
  const url = buildUrl(path, req.base ?? DEFAULT_BASE, req.query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? 'GET',
      credentials: 'include', // 会话是 HttpOnly Cookie，前端不存 token
      headers: req.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: req.signal,
    });
  } catch {
    // 网络层失败：status 0，UI 才能区分「断网」与「服务端 500」
    throw new ApiError(0, 'network', '网络不可用，请检查连接');
  }

  if (res.status === 204) return undefined as T;

  let payload: unknown = undefined;
  try {
    payload = await res.json();
  } catch {
    payload = undefined;
  }

  if (!res.ok) {
    const body = (payload ?? {}) as ErrorBody;
    const retryAfter = res.headers.get('retry-after');
    throw new ApiError(
      res.status,
      body.error?.code ?? 'common.internal',
      body.error?.message ?? '请求失败（' + res.status + '）',
      body.error?.request_id,
      body.error?.fields,
      retryAfter ? Number(retryAfter) * 1000 : undefined,
    );
  }

  return (payload as { data: T }).data;
}
