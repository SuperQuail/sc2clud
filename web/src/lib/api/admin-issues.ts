import { api, apiPage } from './client';
import { pageQuery, type PageQuery } from './paging';

// 管理端「Issue 管理」屏的**类型与请求函数**（契约 2026-10-16 冻结）。
// 为什么单独一个文件：admin-types.ts 与 admin.ts 都在 gate:size 的 500 行线上，
// 这一屏的两块（DTO + 三条请求）放进去就把两份都推过线 —— 与「类型 / 请求分家」同一条理由。
// admin.ts 原样再出口一次，调用方照旧从 '@/lib/api/admin' 引（同 admin-types 的做法）。

/** IssueAdminDTO：字段名小写下划线，逐字照契约抄。三处与公开 IssueDTO 不同（别混用）：
 *    · id 是 issue 的 public_id（uuid），**编号在 number**；
 *    · 正文字段叫 body_html，但没有 body_md —— 后端不回 Markdown 源；
 *    · status 的值域是 keep_open | closed，归档不是状态而是 archived_at。 */
export type IssueAdmin = {
  id: string;
  number: number;
  kind: string;
  title: string;
  body_html: string;
  status: 'keep_open' | 'closed';
  tags: string[];
  created_at: string;
  updated_at: string;
  /** 归档不是删除：非空 = 已被管理员归档（公开读一律排除它） */
  archived_at: string | null;
  /** 归档人（没有时为 null —— 历史数据或系统动作） */
  archived_by: { handle: string; nickname: string } | null;
  archive_reason: string;
  author: { handle: string; nickname: string; avatar_hash: string | null };
  topic: { id: string; title: string };
};
/** 归档档位：0=未归档（默认）、1=已归档、all=全部。archived=1|all **只对持 post.review 的人有效**。 */
export type IssueAdminFilter = {
  archived?: '0' | '1' | 'all';
  status?: 'open' | 'closed';
  kind?: string;
  q?: string;
} & PageQuery;

// 列表走**列表包络** {data, next_cursor}（apiPage）；筛选与自增在 SQL 里做，前端不过滤。
// 两个动作与 pin/lock 同形：POST + 200 {"ok":true}，写 audit_logs（issue.archive / issue.restore）。
export function fetchAdminIssues(f: IssueAdminFilter = {}, signal?: AbortSignal): Promise<{ items: IssueAdmin[]; next: string | null }> {
  return apiPage<IssueAdmin>('admin/issues', {
    query: { archived: f.archived, status: f.status, kind: f.kind, q: f.q?.trim() || undefined, ...pageQuery(f) },
    signal,
  });
}

/** 归档：reason 可空（后端收可空）。语义与公开读「archived_at IS NULL」对上：非管理员看 404。 */
export function adminArchiveIssue(id: string, reason: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>('admin/issues/' + encodeURIComponent(id) + '/archive', { method: 'POST', body: { reason } });
}

/** 恢复：与归档同一形状，无 body。 */
export function adminRestoreIssue(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>('admin/issues/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
}
