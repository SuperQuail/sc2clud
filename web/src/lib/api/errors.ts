// 统一的接口错误类型（前端方案 §5.2）。组件禁止自己判 response.status。
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly fields?: Record<string, string>,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

// 状态码 → UI 该做什么。只有这里做映射，组件只消费结论。
export type UiAction = 'login' | 'form' | 'toast' | 'notfound' | 'retry';

export function uiActionFor(e: ApiError): UiAction {
  if (e.status === 401) return 'login';
  if (e.status === 400 && e.fields) return 'form';
  if (e.status === 404) return 'notfound';
  if (e.status === 429) return 'retry';
  return 'toast';
}
