// 游标分页的请求侧参数（v2 §21.1：禁止 page/offset，limit 默认 20 / 上限 100）。
// 响应侧的解析在 client.ts 的 apiPage()：**next_cursor 在 data 外面**，只有那里知道包络的形状。
export const PAGE_LIMIT = 20;

export type PageQuery = { limit?: number; cursor?: string | null };

export function pageQuery(q: PageQuery): Record<string, string | number | undefined> {
  return { limit: q.limit ?? PAGE_LIMIT, cursor: q.cursor ?? undefined };
}
