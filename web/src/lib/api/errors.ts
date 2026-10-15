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

/** 「错误行」的全站唯一实现：**message 优先、fields 次之、request_id 只作次要附注**（D65）。
 *  各页那张 code→话术的映射还归各页（那是业务文案，不是排版）；这里只统一顺序与括号样式。
 *  字段级理由必须带上：后端把「哪个字段、错在哪」放在 fields（apperr.Invalid）里，
 *  只印一句「参数错误」等于让用户反复猜 —— 2026-10-15 头衔新建实测（key 带连字符谁也看不出）。 */
export function apiErrorLine(e: ApiError): string {
  const f = (e.fields ?? {}) as Record<string, string>;
  const detail =
    Object.entries(f)
      .filter(([k]) => k !== '_')
      .map(([k, v]) => k + '：' + v)
      .join('；') || f['_'] || '';
  return e.message + (detail ? '（' + detail + '）' : '') + (e.requestId ? '（错误编号 ' + e.requestId + '）' : '');
}
