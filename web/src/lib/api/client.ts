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
  // base 与 path 之间**必须有且只有一个斜杠**：DEFAULT_BASE 是 '<base>api/v1'（无尾斜杠）、path 不带前斜杠，
  // 直接相加会拼出 /api/v1me 这种 URL —— 它 404、但看起来完全正常（这条是被 app.test 的 fetch 断言抓出来的）。
  const root = base.endsWith('/') ? base : base + '/';
  const url = root + path.replace(/^\/+/, '');
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
  // 单对象包络：{ "data": … }（§21.1）。列表请用 apiPage —— 列表的 next_cursor 在 data **外面**。
  const payload = (await request(path, req)) as { data?: T } | undefined;
  return payload?.data as T;
}

/**
 * 列表端点专用：**包络是 { data: [...], next_cursor }**，而 next_cursor 在 data **外面**。
 * 所以列表不能走 api<T>()（它只取 payload.data，游标会丢 —— 这是被首页的测试抓出来的）：
 * 丢了游标的后果是「加载更多」永远到底，而接口看起来完全正常。
 */
export async function apiPage<T>(path: string, req: Req = {}): Promise<{ items: T[]; next: string | null }> {
  const payload = (await request(path, req)) as { data?: T[]; next_cursor?: string | null } | undefined;
  return { items: payload?.data ?? [], next: payload?.next_cursor ?? null };
}

/**
 * 少数端点的包络比 apiPage 多一个字段（私信会话页的 peer，d4 §5.2）。
 * 整包拿回来由调用方取：为它单独写一个 apiThread() 只会把「包络有几种」这件事散到两个函数里。
 */
export async function apiEnvelope<T>(path: string, req: Req = {}): Promise<T> {
  return (await request(path, req)) as T;
}

// 全站唯一的 fetch 调用点：api / apiPage 都走它。**返回的是完整包络**（解析与解包是两件事）
async function request(path: string, req: Req = {}): Promise<unknown> {
  const url = buildUrl(path, req.base ?? DEFAULT_BASE, req.query);

  // multipart（头像上传）**不能**套 JSON：content-type 必须留给浏览器带 boundary，body 也不能序列化。
  const form = req.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method ?? 'GET',
      credentials: 'include', // 会话是 HttpOnly Cookie，前端不存 token
      headers: req.body === undefined || form ? undefined : { 'content-type': 'application/json' },
      body: form ? (req.body as FormData) : req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: req.signal,
    });
  } catch {
    // 网络层失败：status 0，UI 才能区分「断网」与「服务端 500」
    throw new ApiError(0, 'network', '网络不可用，请检查连接');
  }

  if (res.status === 204) return undefined;

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

  return payload;
}
