import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import { fetchUsers } from '@/lib/api/admin';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  fetchGroupMembers,
  fetchGroups,
  removeGroupMember,
  updateGroup,
} from '@/lib/api/groups';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { GroupsScreen } from '@/devroom/pages/15-admin/screens/groups';

// ── 用户组屏的宿主（D38）── 组这扇门走 user.ban（与用户管理同一档），
// 分区里的按组名单在 boards 容器里接（board.manage）。

export function GroupsScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  const list = useQuery({ queryKey: qk.adminGroups(), queryFn: ({ signal }) => fetchGroups(signal) });
  const groups = list.data ?? [];
  const group = groups.find((g) => g.id === groupId) ?? groups[0] ?? null;
  const gid = group?.id ?? '';

  const members = useQuery({
    queryKey: qk.adminGroupMembers(gid),
    queryFn: ({ signal }) => fetchGroupMembers(gid, signal),
    enabled: gid !== '',
  });
  // 候选人照 boards 的同一现实：用户列表第一页（没有按 handle 搜人的轻量读口）。
  const users = useQuery({
    queryKey: qk.adminUsers({ for: 'group-member-candidates' }),
    queryFn: ({ signal }) => fetchUsers({ limit: 50 }, signal),
    enabled: can(session.session, 'user.ban'),
  });

  const afterWrite = (msg: string) => {
    setReceipt(msg);
    void qc.invalidateQueries({ queryKey: qk.adminGroups() });
  };

  const save = useMutation({
    mutationFn: (v: { id: string; patch: { name: string; description: string } }) => updateGroup(v.id, v.patch),
    onSuccess: () => { afterWrite('已保存组资料'); setSavedAt((n) => n + 1); },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });
  const create = useMutation({
    mutationFn: (b: { key: string; name: string; description: string }) => createGroup(b),
    onSuccess: (g) => { setGroupId(g.id); afterWrite('已建组「' + g.name + '」（key=' + g.key + '）'); setSavedAt((n) => n + 1); },
    onError: (e) => setReceipt('新建失败：' + (errorLine(e) ?? '')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSuccess: () => afterWrite('已删除该组（成员与按组授权行同时清空）'),
    onError: (e) => setReceipt('删除失败：' + (errorLine(e) ?? '')),
  });
  const add = useMutation({
    mutationFn: (v: { id: string; userId: string }) => addGroupMember(v.id, v.userId),
    onSuccess: (items) => { setReceipt('已拉人入组（判定当场生效）'); void qc.setQueryData(qk.adminGroupMembers(gid), items); },
    onError: (e) => setReceipt('入组失败：' + (errorLine(e) ?? '')),
  });
  const removeMember = useMutation({
    mutationFn: (v: { id: string; userId: string }) => removeGroupMember(v.id, v.userId),
    onSuccess: (items) => { setReceipt('已移出该成员（按组授予的资格立刻失效）'); void qc.setQueryData(qk.adminGroupMembers(gid), items); },
    onError: (e) => setReceipt('移出失败：' + (errorLine(e) ?? '')),
  });

  const busy = save.isPending || create.isPending || remove.isPending || add.isPending || removeMember.isPending;

  return (
    <GroupsScreen
      key={gid || 'no-group'}
      groups={groups}
      loading={list.isPending}
      error={list.error ? { message: errorLine(list.error) ?? '', status: 0 } : null}
      groupId={group?.id ?? null}
      onSelect={(next) => { setGroupId(next); setReceipt(null); }}
      onCreate={(b) => create.mutate(b)}
      onSave={(id, patch) => save.mutate({ id, patch })}
      onDelete={(id) => remove.mutate(id)}
      savedAt={savedAt}
      saving={save.isPending}
      deleting={remove.isPending}
      members={members.data ?? []}
      membersLoading={members.isPending && gid !== ''}
      candidates={(users.data?.items ?? []).map((u) => ({ id: u.id, username: u.username, nickname: u.nickname }))}
      loadingCandidatesFailed={users.isError}
      onAddMember={(userId) => { if (group) add.mutate({ id: group.id, userId }); }}
      onRemoveMember={(userId) => { if (group) removeMember.mutate({ id: group.id, userId }); }}
      addingMember={add.isPending}
      canManage={can(session.session, 'user.ban')}
      busy={busy}
      receipt={receipt ? <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p> : null}
    />
  );
}