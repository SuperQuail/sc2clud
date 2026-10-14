import { useMemo, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  banUser, fetchRoles, fetchTitles, fetchUsers,
  grantTitle, revokeUserSessions, setUserRole,
} from '@/lib/api/admin';
import type { AdminUserFilter } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { Empty } from '@/routes/_parts/state';
import { UsersScreen, type UsersFilter } from '@/devroom/pages/15-admin/screens/users';

// 后台各屏的**取数容器**（宿主）：把 /admin/* 的查询与动作变成屏的 props。
//
// 为什么单独一个文件、而不是把查询写进 routes/admin.tsx：
//   ① 体量（gate:size ≤ 500 行）；② 这里的东西每接一屏涨一截，而 admin.tsx 的布局不该跟着涨。
//
// 规矩：一个屏一个容器，容器里只做「取数 + 调用 + 回执」，屏里只摆版式（照 topic-view 的分工）。
// 容器与屏都在（而不是在 admin.tsx 里 switch）：**hooks 不能条件渲染**，而 useQuery 的 enabled
// 只能按屏开 —— 写成「一个组件里十个 useQuery」会让「打开用户屏」顺手打 8 个不相干的请求。

/** 容器把任何失败翻成一句人话（不吞错误，也不把 500 说成「没有数据」）。 */
export function errorLine(e: unknown): string | null {
  if (!e) return null;
  if (isApiError(e)) return 'HTTP ' + e.status + ' ' + e.message + (e.requestId ? '（编号 ' + e.requestId + '）' : '');
  return String(e);
}

/** 这一屏要用的端点还没有时的统一说法（**不拿示例数据兜底**：那样看起来像已经接完了）。 */
function MissingEndpoint({ perm, what, endpoints }: { perm: string; what: string; endpoints: string[] }) {
  return (
    <Empty
      title={what + '还没有可以对接的端点'}
      hint={
        '这一屏已经改成 prop 驱动、权限点也按真实 perms 判（' + perm + '），但后端还缺：' +
        endpoints.join('、') + '。在这一条落地前它不会拿示例数据兜底 —— ' +
        '「界面看着正常、其实什么都没发生」正是本仓库要消灭的形态。'
      }
    />
  );
}

// ── 屏 a：用户管理 ────────────────────────────────────────────────────────
// 依赖 GET /admin/users（交接单 C1，W-D1 在补）+ 已实装的 /admin/roles、/admin/titles 与四个动作端点。

export function UsersScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<UsersFilter>({ q: '', status: 'all', role: 'all' });
  const [receipt, setReceipt] = useState<string | null>(null);

  // 三根状态轴在 wire 上是两个独立布尔（auth/pgsql/admin_users.go 的 AdminUsersFilter）——
  // **不能合成一个 status 参数**：待激活与未验证是两根轴，合成后筛「未验证」会漏掉已激活的。
  const apiFilter: AdminUserFilter = useMemo(() => ({
    q: filter.q.trim() || undefined,
    status: filter.status === 'banned' ? 'banned' : undefined,
    activated: filter.status === 'pending_act' ? 'false' : filter.status === 'normal' ? 'true' : undefined,
    email_verified: filter.status === 'unverified' ? 'false' : undefined,
    role: filter.role === 'all' ? undefined : filter.role,
  }), [filter]);

  const users = useQuery({ queryKey: qk.adminUsers(apiFilter), queryFn: ({ signal }) => fetchUsers(apiFilter, signal) });
  const roles = useQuery({ queryKey: qk.adminRoles(), queryFn: ({ signal }) => fetchRoles(signal) });
  const titles = useQuery({ queryKey: qk.adminTitles(), queryFn: ({ signal }) => fetchTitles(signal) });

  const done = (msg: string) => { setReceipt(msg); void qc.invalidateQueries({ queryKey: ['admin'] }); };
  const ban = useMutation({
    mutationFn: async (v: { ids: string[]; action: 'ban' | 'unban'; reason: string }) => {
      // 逐条调用：后端**没有**批量用户端点（交接单 C6），所以这里如实逐条发，并把成功条数报回去。
      let ok = 0; const failed: string[] = [];
      for (const id of v.ids) {
        try { await banUser(id, v.action, v.reason); ok++; } catch (e) { failed.push(id + '：' + (errorLine(e) ?? '')); }
      }
      return { ok, failed };
    },
    onSuccess: (r) => done(r.failed.length === 0
      ? '已处理 ' + r.ok + ' 个用户'
      : '成功 ' + r.ok + ' 个，失败 ' + r.failed.length + ' 个：' + r.failed.slice(0, 3).join('；')),
    onError: (e) => setReceipt('操作失败：' + errorLine(e)),
  });
  const revoke = useMutation({
    mutationFn: revokeUserSessions,
    onSuccess: (r) => done('已踢掉 ' + r.revoked + ' 个会话'),
    onError: (e) => setReceipt('踢会话失败：' + errorLine(e)),
  });
  const role = useMutation({
    mutationFn: (v: { id: string; roleId: number }) => setUserRole(v.id, v.roleId),
    onSuccess: () => done('基线角色已改（角色之间永不并集，这是替换）'),
    onError: (e) => setReceipt('改角色失败：' + errorLine(e)),
  });
  const title = useMutation({
    mutationFn: (v: { userId: string; titleId: string }) => grantTitle(v.userId, v.titleId),
    onSuccess: () => done('头衔已授予'),
    onError: (e) => setReceipt('发头衔失败：' + errorLine(e)),
  });

  const me = session.session;
  const receiptNode = receipt ? (
    <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
  ) : null;

  return (
    <UsersScreen
      users={users.data?.items ?? []}
      total={users.data?.items.length ?? 0}
      loading={users.isPending}
      error={users.error ? { message: errorLine(users.error) ?? '', status: isApiError(users.error) ? users.error.status : 0 } : null}
      filter={filter}
      onFilterChange={setFilter}
      roles={roles.data ?? []}
      titles={titles.data ?? []}
      canBan={can(me, 'user.ban')}
      canAssignRole={can(me, 'role.assign')}
      canGrantTitle={can(me, 'title.grant')}
      onBan={(ids, action, reason) => ban.mutate({ ids, action, reason })}
      onRevokeSessions={(id) => revoke.mutate(id)}
      onSetRole={(id, roleId) => role.mutate({ id, roleId })}
      onGrantTitle={(userId, titleId) => title.mutate({ userId, titleId })}
      receipt={receiptNode}
    />
  );
}

// 其余 11 屏的容器在下面逐屏加（一屏一个提交，见 完全重构/进行中/进度-W-D2.md 的顺序）。
// 没有容器的屏先不接：拿示例数据兜底会让「没接完」看起来像「接完了」。
const PENDING_SCREENS: Record<string, { perm: string; what: string; endpoints: string[] }> = {
  boards: { perm: 'board.manage', what: '分区管理', endpoints: ['GET /admin/boards', 'PUT /admin/boards/{id}/acl', 'POST /admin/boards/reorder'] },
  diagnostics: { perm: 'site.setting', what: '自检面板', endpoints: ['GET /admin/diagnostics'] },
};

/** 造一个「这一屏的端点还没到」的占位屏。工厂而不是组件：admin.tsx 的映射表要的是组件类型。 */
export function PendingScreen(key: string): ComponentType<Record<string, never>> {
  const p = PENDING_SCREENS[key];
  if (!p) throw new Error('PendingScreen: 没有登记 ' + key);
  const C = () => <MissingEndpoint perm={p.perm} what={p.what} endpoints={p.endpoints} />;
  C.displayName = 'PendingScreen_' + key;
  return C;
}
