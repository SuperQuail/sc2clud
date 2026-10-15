// 展示层的格式化：接口给的一律是 RFC3339 UTC 与整数分（后端方案 §14.7）

/** 「2026-10-16 07:31」：sv-SE 的 short/short 恰好是分钟精度（D74：评论区不吃整串 RFC3339） */
export function formatMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short' }).format(d);
}

export function formatTime(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 60 * 24) return Math.floor(minutes / 60) + ' 小时前';
  if (minutes < 60 * 24 * 7) return Math.floor(minutes / 1440) + ' 天前';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(then);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
