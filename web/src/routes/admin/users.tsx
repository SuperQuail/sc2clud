import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  activateUser,
  banUser,
  adminSetUserPassword,
  fetchRoles,
  fetchTitles,
  fetchUserDetail,
  fetchUsers,
  grantTitle,
  revokeTitle,
  revokeUserSessions,
  setUserRole,
} from '@/lib/api/admin';
import type { AdminUserDetail } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { UsersScreen, type UsersCounts, type UsersFilter } from '@/devroom/pages/15-admin/screens/users';
import { PAGE_SIZE } from '@/devroom/pages/15-admin/screens/users-footer';

// ── 屏 a：用户管理 ────────────────────────────────────────────────────────
// 依赖 GET /admin/users?v=2 与 GET /admin/users/{id}（C1 已落地）+ 已实装的 /admin/roles、/admin/titles
// 与四个动作端点。列表项与详情是**两个形状**：那三张关联表只有详情接口给，所以选中一行才去取。
//
// 翻页（FIX-USERS）：**游标栈**。后端按 (id DESC) 的键集游标分页，没有 page/offset 参数，
// 所以「第 N 页」只能由一串游标表达：cursors[i] 是取第 i+1 页用的那个游标。
//   · 上一页 = 回到 cursors[page-2]；下一页 = 先请求 cursors[page-1]，拿到 next_cursor 再追加；
//   · 只支持往前一步（跳页上界 = 已到过的下一页）—— 再远的页没有游标，只能依次取过去。
// 换页必须换 queryKey（cursor 在里面）：否则 react-query 会把第一页的缓存直接还给第 2 页，
// 屏上出现「页码变了、数据没变」——这正是这一条缺陷原来的样子。
//
// 为什么不用 offset：偏移分页在两次请求之间有人注册就会漏行/重行，且与 v2 §21.1（禁止 page/offset）冲突。

export function UsersScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [filter, setFilter] = useState<UsersFilter>({ q: '', status: 'all', role: 'all' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // 下标 0 是第 1 页的游标（空串 = 从头取）。只装**已经取到过**的页的游标。
  const [cursors, setCursors] = useState<string[]>(['']);

  // 三根状态轴在 wire 上是两个独立布尔（auth/pgsql/admin_users.go 的 AdminUsersFilter）——
  // **不能合成一个 status 参数**：待激活与未验证是两根轴，合成后筛「未验证」会漏掉已激活的。
  const apiFilter = {
    q: filter.q.trim() || undefined,
    status: filter.status === 'banned' ? 'banned' : undefined,
    activated: filter.status === 'pending_act' ? 'false' : filter.status === 'normal' ? 'true' : undefined,
    email_verified: filter.status === 'unverified' ? 'false' : undefined,
    role: filter.role === 'all' ? undefined : filter.role,
    // 列表与页脚都用这一个常量：页数写 20 而请求 limit 是别的数，屏上的「共几页」就是假的
    limit: PAGE_SIZE,
    cursor: cursors[page - 1],
  };
  const users = useQuery({ queryKey: qk.adminUsers(apiFilter), queryFn: ({ signal }) => fetchUsers(apiFilter, signal) });

  // 换筛选条件 / 改完数据之后回到第一页：留着第 3 页的游标去取新的筛选结果，页码与内容对不上。
  const resetPages = () => { setPage(1); setCursors(['']); };

  const goPage = (next: number) => {
    if (next < 1 || next > cursors.length) return; // 没有那一页的游标就什么都不做（不假装翻过去了）
    setPage(next);
  };
  const goNext = () => {
    const next = users.data?.next;
    if (!next) return;
    // 走到头之后再回来（上一页再下一页）不该重复追加同一个游标
    setCursors((cur) => (cur[page] === next ? cur : [...cur.slice(0, page), next]));
    setPage(page + 1);
  };

  // 选中即取详情（不是随列表一起取：三张关联表每行都拉一次是 N+1）。**不缓存上一行**：
  // 换了人就把旧详情清掉，否则右栏会显示上一个用户的处罚记录 —— 那比空白危险。
  const pick = (id: string) => {
    setActiveId(id);
    setDetail(null);
    void fetchUserDetail(id)
      .then((d) => setDetail((cur) => (cur === null || cur.id === id ? d : cur)))
      .catch((e) => setReceipt('详情没能加载：' + (errorLine(e) ?? '')));
  };
  const roles = useQuery({ queryKey: qk.adminRoles(), queryFn: ({ signal }) => fetchRoles(signal) });
  const titles = useQuery({ queryKey: qk.adminTitles(), queryFn: ({ signal }) => fetchTitles(signal) });

  // 失败时也要回第一页：被拒的动作（最后一个超管不可降权之类）常发生在翻到后面几页时，
  // 而错误行就在列表上方 —— 停在第 3 页会把它藏起来。
  const done = (msg: string) => { setReceipt(msg); resetPages(); void qc.invalidateQueries({ queryKey: ['admin'] }); };
  const ban = useMutation({
    mutationFn: async (v: { ids: string[]; action: 'ban' | 'unban'; reason: string }) => {
      // 逐条调用而不是打批量端点（C6 的 POST /admin/users/batch）：那一条的 reason 是**整批一个**，
      // 而这里每一行可能因为守卫（最后一个超管、越权改角色）单独失败 —— 逐条发才拿得到「哪一条为什么失败」。
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
  const activate = useMutation({
    // 与封号同一条形状：逐条发，拿得到「哪一条为什么失败」（批量端点的 reason 是整批一个）
    mutationFn: async (ids: string[]) => {
      let ok = 0; const failed: string[] = [];
      for (const id of ids) {
        try { await activateUser(id); ok++; } catch (e) { failed.push(id + '：' + (errorLine(e) ?? '')); }
      }
      return { ok, failed };
    },
    onSuccess: (r) => done(r.failed.length === 0
      ? '已激活 ' + r.ok + ' 个用户（只写 activated_at，不影响邮箱验证）'
      : '成功 ' + r.ok + ' 个，失败 ' + r.failed.length + ' 个：' + r.failed.slice(0, 3).join('；')),
    onError: (e) => setReceipt('激活失败：' + errorLine(e)),
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
  // 头衔编辑弹层里的每一次勾选：held 决定发 POST（授予）还是 DELETE（撤销，title/handler.go:42，204 空回执）。
  // 持有清单随后的变化由弹层自己失效 qk.userTitles 负责（handle 只有弹层知道），这里只管发请求与回执。
  const title = useMutation({
    mutationFn: (v: { userId: string; titleId: string; held: boolean }) =>
      v.held ? grantTitle(v.userId, v.titleId) : revokeTitle(v.userId, v.titleId),
    onSuccess: (_r, v) => done((v.held ? '已授予 ' : '已收回 ') + (titles.data?.find((t) => t.id === v.titleId)?.name ?? v.titleId)),
    onError: (e) => setReceipt('头衔改动失败：' + errorLine(e)),
  });
  // D56：重置密码的成败**由弹层自己**吃到（成功展示一次性密码、失败不关窗）——
  // 容器只在成功后刷新缓存，回执写在弹层里，这里不再重复报一条。
  const resetPw = useMutation({
    mutationFn: (v: { id: string; password: string }) => adminSetUserPassword(v.id, v.password),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin'] }),
  });

  const me = session.session;
  const receiptNode = receipt ? (
    <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
  ) : null;
  // 拿不到 counts 时不假装有总数：0 明显是「还不知道」，而编一个本页条数会被读成「全站就这么多人」
  const counts: UsersCounts = users.data?.counts ?? { total: 0, banned: 0, pending_activation: 0, email_unverified: 0 };

  return (
    <UsersScreen
      users={users.data?.items ?? []}
      detail={activeId && detail?.id === activeId ? detail : null}
      detailLoading={activeId !== null && detail?.id !== activeId}
      onSelect={pick}
      counts={counts}
      page={page}
      canNext={Boolean(users.data?.next)}
      onPage={(p) => { if (p === page + 1) goNext(); else goPage(p); }}
      size={PAGE_SIZE}
      loading={users.isPending}
      error={users.error ? { message: errorLine(users.error) ?? '', status: isApiError(users.error) ? users.error.status : 0 } : null}
      filter={filter}
      onFilterChange={(f) => { setFilter(f); setActiveId(null); setDetail(null); resetPages(); }}
      roles={roles.data ?? []}
      titles={titles.data ?? []}
      canBan={can(me, 'user.ban')}
      canAssignRole={can(me, 'role.assign')}
      canGrantTitle={can(me, 'title.grant')}
      onBan={(ids, action, reason) => ban.mutate({ ids, action, reason })}
      onActivate={(ids) => activate.mutate(ids)}
      onRevokeSessions={(id) => revoke.mutate(id)}
      onSetRole={(id, roleId) => role.mutate({ id, roleId })}
      onSetTitle={(userId, titleId, held) => title.mutateAsync({ userId, titleId, held })}
      onResetPassword={(id, password) => resetPw.mutateAsync({ id, password })}
      receipt={receiptNode}
    />
  );
}
