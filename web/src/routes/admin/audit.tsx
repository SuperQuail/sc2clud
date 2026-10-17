import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
auditExportUrl,
fetchAuditLogs,
} from '@/lib/api/admin';

import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { BASE } from '@/lib/base';
import { errorLine } from './_shared';
import { AuditScreen, ESCALATION_ACTIONS, type AuditFilter } from '@/devroom/pages/15-admin/screens/audit';

// ── 屏 j：审计日志 ────────────────────────────────────────────────────────
// 依赖 GET /admin/audit-logs（筛选齐全）与 GET /admin/audit-logs/export（csv）。
// 导出走 <a href> 直下文件，不经 fetch（前端方案 §5 的 fetch 唯一出口管不到浏览器下载）。

export function AuditScreenContainer() {
  const session = useSession();
  const [filter, setFilter] = useState<AuditFilter>({ collector: 'all', target_type: 'all', action: 'all', keyword: '', from: '', to: '' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  // 「只看提权类」不是后端的一个参数（它是**多个动作**），所以那两档在前端落到屏上筛本页；
  // 其余三档（操作者 / 目标类型 / 具体动作）后端都收，直接进 query。
  const apiFilter = useMemo(() => ({
    actor: filter.collector === 'all' || filter.collector === 'system' ? undefined : filter.collector,
    target_type: filter.target_type === 'all' ? undefined : filter.target_type,
    action: filter.action === 'all' || filter.action === 'escalation' ? undefined : filter.action,
    target_id: filter.keyword.trim() || undefined,
    from: filter.from.trim() || undefined,
    to: filter.to.trim() || undefined,
    cursor,
  }), [filter, cursor]);

  const logs = useQuery({
    queryKey: qk.adminAudit(apiFilter),
    queryFn: ({ signal }) => fetchAuditLogs(apiFilter, signal),
  });

  const me = session.session;
  const rows = (logs.data?.items ?? []).filter((l) => {
    if (filter.collector === 'system' && l.actor) return false;
    if (filter.action === 'escalation' && !ESCALATION_ACTIONS.includes(l.action)) return false;
    return true;
  });

  return (
    <AuditScreen
      items={rows}
      hasMore={Boolean(logs.data?.next)}
      loading={logs.isPending}
      error={logs.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          审计日志没能加载（HTTP {isApiError(logs.error) ? logs.error.status : 0}）：{errorLine(logs.error)}
        </p>
      ) : null}
      filter={filter}
      onFilterChange={(next) => { setFilter(next); setCursors([null]); }}
      onLoadMore={() => { if (logs.data?.next) setCursors((c) => [...c, logs.data!.next]); }}
      canView={can(me, 'audit.view')}
      canExport={can(me, 'audit.export')}
      exportHref={auditExportUrl(BASE, {
        target_type: apiFilter.target_type, action: apiFilter.action, actor: apiFilter.actor,
        from: apiFilter.from, to: apiFilter.to, target_id: apiFilter.target_id,
      })}
    />
  );
}

