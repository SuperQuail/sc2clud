import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  banUser,
  fetchRoles,
  fetchTitles,
  fetchUsers,
  grantTitle,
  revokeUserSessions,
  setUserRole,
} from '@/lib/api/admin';
import type {
AdminUserFilter,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { UsersScreen, type UsersFilter } from '@/devroom/pages/15-admin/screens/users';

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

