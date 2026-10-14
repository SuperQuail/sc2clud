import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  createBoard,
  fetchAdminBoards,
  fetchBoardAcl,
  fetchBoardModerators,
  fetchRoles,
  fetchUsers,
  grantBoardModerator,
  replaceBoardAcl,
  reorderBoards,
  revokeBoardModerator,
  updateBoard,
} from '@/lib/api/admin';
import type {
  AdminACLItem,
  AdminBoard,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { BoardsScreen, type BoardPatch } from '@/devroom/pages/15-admin/screens/boards';

// ── 屏 c：分区管理 + BoardACL（C2，9 条路由已落地）─────────────────────────
// 三个取数口，各有各的理由：
//  · GET /admin/boards  —— 列表本身（含归档）。不翻页：后台分区是几十个，不是几万个。
//  · GET /admin/boards/{id}/acl —— 矩阵按选中分区取（列表里刻意不带：4 个角色 × N 个分区是 4N 行，
//    只有打开某个分区时才该发那一次请求）。
//  · GET /admin/boards/{id}/moderators —— 版主任期（**含已卸任的历史行**）。列表项里的 moderators[]
//    只有在任的，「谁什么时候被免的」只有这个读口答得出来。
//
// 草稿在**屏里**（它自己的 state），宿主只发号：savedAt 一变屏就把草稿对齐到落库值。
// 这样宿主不需要「后端值一变就整份换掉」那种同步 effect（列表每次重取都是新对象，那种写法会把
// 管理员刚敲的字冲掉 —— settings 屏是被 React Query 的 structural sharing 救下来的，这里不赌那个）。

export function BoardsScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [boardId, setBoardId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [receipt, setReceipt] = useState<string | null>(null);

  const list = useQuery({ queryKey: qk.adminBoards(), queryFn: ({ signal }) => fetchAdminBoards(signal) });
  const boards = list.data ?? [];
  const board = boards.find((b) => b.id === boardId) ?? boards[0] ?? null;
  const id = board?.id ?? '';

  const acl = useQuery({ queryKey: qk.adminBoardAcl(id), queryFn: ({ signal }) => fetchBoardAcl(id, signal), enabled: id !== '' });
  const mods = useQuery({ queryKey: qk.adminBoardModerators(id), queryFn: ({ signal }) => fetchBoardModerators(id, signal), enabled: id !== '' });
  const roles = useQuery({ queryKey: qk.adminRoles(), queryFn: ({ signal }) => fetchRoles(signal) });
  // 任命版主要有 user_id（uuid），而**没有「按 handle 搜用户」的轻量读口**：只取用户列表第一页给人挑。
  // 拿不到（没有 user.ban）时它是空数组，屏上会说明白「先去用户管理搜到那个人」。
  const users = useQuery({
    queryKey: qk.adminUsers({ for: 'board-moderator-candidates' }),
    queryFn: ({ signal }) => fetchUsers({ limit: 50 }, signal),
    enabled: can(session.session, 'user.ban'),
  });

  const afterWrite = (msg: string) => { setReceipt(msg); void qc.invalidateQueries({ queryKey: ['admin', 'boards'] }); };

  const save = useMutation({
    mutationFn: (v: { id: string; patch: Partial<BoardPatch> }) => updateBoard(v.id, v.patch),
    onSuccess: (next, v) => {
      setReceipt('已保存 ' + Object.keys(v.patch).join('、'));
      // PATCH 返回的就是同一形状的整行：回写列表那一行，并发号让屏把草稿对齐到落库值
      void qc.setQueryData<AdminBoard[]>(qk.adminBoards(), (old) => old?.map((b) => (b.id === next.id ? next : b)));
      setSavedAt((n) => n + 1);
    },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });
  const create = useMutation({
    mutationFn: createBoard,
    onSuccess: (b) => { setBoardId(b.id); afterWrite('已新建分区 /' + b.slug + '（slug 建后不可改）'); },
    onError: (e) => setReceipt('新建失败：' + (errorLine(e) ?? '')),
  });
  const move = useMutation({
    // **必须给全部 id**（后端少一个就 400）：屏上把整个新顺序发下来
    mutationFn: (ids: string[]) => reorderBoards(ids).then(() => ids),
    onSuccess: (ids) => { setReceipt('顺序已保存（' + ids.length + ' 个分区，全量顺序）'); void qc.invalidateQueries({ queryKey: qk.adminBoards() }); },
    onError: (e) => { setReceipt('排序失败：' + (errorLine(e) ?? '')); void qc.invalidateQueries({ queryKey: qk.adminBoards() }); },
  });
  const saveAcl = useMutation({
    mutationFn: (v: { id: string; acls: AdminACLItem[] }) => replaceBoardAcl(v.id, v.acls),
    onSuccess: (items) => { setReceipt('矩阵已保存（全量替换：' + items.length + ' 行）'); void qc.setQueryData(qk.adminBoardAcl(id), items); },
    onError: (e) => setReceipt('矩阵保存失败：' + (errorLine(e) ?? '')),
  });
  const grant = useMutation({
    mutationFn: (v: { id: string; userId: string; until: string }) => grantBoardModerator(v.id, v.userId, v.until),
    onSuccess: () => afterWrite('已任命版主（权限快照已失效，这个人马上生效）'),
    onError: (e) => setReceipt('任命失败：' + (errorLine(e) ?? '')),
  });
  const revoke = useMutation({
    mutationFn: (v: { id: string; userId: string }) => revokeBoardModerator(v.id, v.userId),
    onSuccess: () => afterWrite('已免职（置 grown_at，行还在，历史任期仍可见）'),
    onError: (e) => setReceipt('免职失败：' + (errorLine(e) ?? '')),
  });

  const busy = save.isPending || create.isPending || move.isPending || grant.isPending || revoke.isPending;
  const err = list.error ?? acl.error ?? mods.error;

  return (
    <BoardsScreen
      // key：换分区就重挂载屏（草稿与矩阵草稿跟着重来）。不用 effect 去同步列表对象 ——
      // 那个对象每次重取都是新的，会让「刚敲的字」在每次后台刷新后消失。
      key={id || 'no-board'}
      boards={boards}
      loading={list.isPending}
      error={err ? { message: errorLine(err) ?? '', status: isApiError(err) ? err.status : 0 } : null}
      boardId={board?.id ?? null}
      onSelect={(next) => { setBoardId(next); setReceipt(null); }}
      onSave={(patch) => { if (board) save.mutate({ id: board.id, patch }); }}
      saving={save.isPending}
      savedAt={savedAt}
      onMove={(ids) => move.mutate(ids)}
      reordering={move.isPending}
      roles={roles.data ?? []}
      acl={acl.data ?? []}
      aclLoading={acl.isPending && id !== ''}
      onAclSave={(acls) => { if (board) saveAcl.mutate({ id: board.id, acls }); }}
      aclSaving={saveAcl.isPending}
      moderators={mods.data ?? []}
      candidates={(users.data?.items ?? []).map((u) => ({ id: u.id, username: u.username, nickname: u.nickname }))}
      // expires_at 是 RFC3339：屏上给的是日期，这里补成当天 23:59:59Z（空 = 永久）
      onGrantModerator={(userId, until) => { if (board) grant.mutate({ id: board.id, userId, until: until ? until + 'T23:59:59Z' : '' }); }}
      onRevokeModerator={(userId) => { if (board) revoke.mutate({ id: board.id, userId }); }}
      onCreate={(b) => create.mutate({ slug: b.slug, name: b.name, description: b.description })}
      onSetStatus={(status, reason) => {
        if (!board) return;
        // 归档/取消归档走同一条 PATCH。**reason 不是入参**（updateBoardBody 没有理由字段），
        // 所以它只进这条回执 —— 不假装它写进了审计（那条审计的 detail 只有 before/after 字段值）。
        setReceipt('状态改成 ' + status + (reason ? '（说明：' + reason + '）' : '') + '；后端不接受理由字段，它只在这条回执里');
        save.mutate({ id: board.id, patch: { status } });
      }}
      canManage={can(session.session, 'board.manage')}
      busy={busy}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}
