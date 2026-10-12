// 展示层的格式化：接口给的一律是 RFC3339 UTC 与整数分（后端方案 §14.7）

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
