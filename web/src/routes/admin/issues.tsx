import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import { adminArchiveIssue, adminRestoreIssue, fetchAdminIssues } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { IssuesAdminScreen, type IssuesAdminFilter } from '@/devroom/pages/15-admin/screens/issues';

// ── 屏 n：Issue 管理（契约 2026-10-16 冻结）────────────────────────────────
// 依赖 GET /admin/issues?archived=&status=&kind=&q=&limit=&cursor=（游标分页，沿用列表包络）
// 与两个动作 POST /admin/issues/{id}/archive|restore（200 {ok:true}，写 audit_logs）。
// 权限点用**既有的 post.review**（RBAC 是 24 点，不新造权限点）。
//
// 归档档位与 status / kind / q **都发给服务端**：前端只持有「当前这一页」，
// 在本地筛会把「还没翻到的页」一起滤掉 —— 那正是本仓库反复修的假结果形态。

export function IssuesAdminScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<IssuesAdminFilter>({ archived: '0', status: 'all', kind: 'all', q: '' });
  // 游标栈：与 review / reports 同款（改筛选就清空 —— 换了筛选条件，旧游标指向的位置没有意义）
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  const apiFilter = useMemo(() => ({
    archived: filter.archived,
    status: filter.status === 'all' ? undefined : filter.status,
    kind: filter.kind === 'all' ? undefined : filter.kind,
    q: filter.q.trim() || undefined,
    cursor,
  }), [filter, cursor]);

  const list = useQuery({
    queryKey: qk.adminIssues(apiFilter),
    queryFn: ({ signal }) => fetchAdminIssues(apiFilter, signal),
  });

  // 归档 / 恢复与 pin / lock 同形：成功只回 {ok:true}（没有回显的新行），所以成功后失效这一屏的查询。
  const act = useMutation({
    mutationFn: (v: { id: string; number: number; kind: 'archive' | 'restore'; reason: string }) =>
      v.kind === 'archive' ? adminArchiveIssue(v.id, v.reason) : adminRestoreIssue(v.id),
    onSuccess: (_r, v) => {
      setReceipt(v.kind === 'archive'
        ? '已归档 #' + v.number + (v.reason ? '（原因：' + v.reason + '）' : '') + '：公开读从此看不到它。'
        : '已恢复 #' + v.number + '：它重新出现在公开列表里。');
      void qc.invalidateQueries({ queryKey: ['admin', 'issues'] });
    },
    // 失败**就地报**（不 rethrow、不落进路由的错误边界）：403 / 404 都要能读出一句人话
    onError: (e) => setReceipt('操作失败：' + (errorLine(e) ?? '')),
  });

  const me = session.session;
  return (
    <IssuesAdminScreen
      items={list.data?.items ?? []}
      hasMore={Boolean(list.data?.next)}
      loading={list.isPending}
      error={list.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          Issue 列表没能加载（HTTP {isApiError(list.error) ? list.error.status : 0}）：{errorLine(list.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); }}
      onLoadMore={() => { if (list.data?.next) setCursors((c) => [...c, list.data!.next]); }}
      canManage={can(me, 'post.review')}
      onArchive={(id, reason) => {
        const row = (list.data?.items ?? []).find((i) => i.id === id);
        act.mutate({ id, number: row?.number ?? 0, kind: 'archive', reason });
      }}
      onRestore={(id) => {
        const row = (list.data?.items ?? []).find((i) => i.id === id);
        act.mutate({ id, number: row?.number ?? 0, kind: 'restore', reason: '' });
      }}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}
