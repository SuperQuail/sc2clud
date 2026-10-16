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

// code → 中文原因。与后端 apperr 的码一一对应（v2 §21.4）：后端 message 缺失时用它兜底。
const CODE_REASON: Record<string, string> = {
  'common.invalid_input': '参数错误',
  'common.unauthorized': '请先登录',
  'common.forbidden': '没有权限',
  'common.not_found': '内容不存在',
  'common.conflict': '数据已变化，请刷新',
  'common.rate_limited': '操作太频繁',
  'common.internal': '服务器错误',
  'auth.email_unverified': '请先验证邮箱',
  'media.too_large': '内容过大',
  network: '网络不可用，请检查连接',
  'common.canceled': '请求已取消',
  'common.timeout': '请求超时',
};

// 第二层兜底：code 也不认识时按 HTTP 状态说。两层都不中才暴露状态码本身。
const STATUS_REASON: Record<number, string> = {
  0: '网络不可用，请检查连接',
  400: '参数错误',
  401: '请先登录',
  403: '没有权限',
  404: '内容不存在',
  408: '请求超时',
  409: '数据已变化，请刷新',
  413: '内容过大',
  429: '操作太频繁',
  499: '请求已取消',
};

/** message 缺失时的兜底原因：先按 code，再按 HTTP 状态。**不许返回空串**（D70：空 message 会让
 *  界面只印出「（错误编号 xxx）」，等于让用户拿一个编号去猜）。 */
export function fallbackReason(status: number, code: string): string {
  return CODE_REASON[code] ?? STATUS_REASON[status] ?? (status >= 500 ? '服务器错误' : '请求失败（HTTP ' + status + '）');
}

/** 「错误行」的全站唯一实现：**正文优先、fields 次之、request_id 只作次要附注**（D65）。
 *  各页那张 code→话术的映射还归各页（那是业务文案，不是排版）；这里只统一顺序与括号样式。
 *  字段级理由必须带上：后端把「哪个字段、错在哪」放在 fields（apperr.Invalid）里，
 *  只印一句「参数错误」等于让用户反复猜 —— 2026-10-15 头衔新建实测（key 带连字符谁也看不出）。
 *  正文为空时把「更具体的那一句」抬成正文：字段理由 > code 表 > HTTP 状态（D70）。 */
export function apiErrorLine(e: ApiError): string {
  const f = (e.fields ?? {}) as Record<string, string>;
  const detail =
    Object.entries(f)
      .filter(([k]) => k !== '_')
      .map(([k, v]) => k + '：' + v)
      .join('；') || f['_'] || '';
  const body = e.message.trim() || detail || fallbackReason(e.status, e.code);
  return body + (detail && body !== detail ? '（' + detail + '）' : '') + (e.requestId ? '（错误编号 ' + e.requestId + '）' : '');
}

/** 页面有更贴业务的正文时用它（如「这个分区不允许你发帖」）：正文留空 = 走 message 为空那条规则。
 *  编号与字段理由的位置只有上面这一处实现，页面不再自己拼一遍（这是 D70 的第二个真源）。 */
export function apiErrorLineWith(e: ApiError, message: string): string {
  return apiErrorLine(new ApiError(e.status, e.code, message, e.requestId, e.fields, e.retryAfterMs));
}
