import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  fetchPermissions,
  fetchRoles,
  replaceRolePerms,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { RolesScreen } from '@/devroom/pages/15-admin/screens/roles';

// ── 屏 b：角色 × 权限矩阵 ──────────────────────────────────────────────────
// 依赖 GET /admin/roles、GET /admin/permissions、PATCH /admin/roles/{id}/permissions（都已在）。
// **没有「新建 / 删除角色」端点**（§5.2 只列了矩阵），所以屏上没有那两颗按钮。

export function RolesScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);

  const roles = useQuery({ queryKey: qk.adminRoles(), queryFn: ({ signal }) => fetchRoles(signal) });
  const perms = useQuery({ queryKey: qk.adminPermissions(), queryFn: ({ signal }) => fetchPermissions(signal) });
  const save = useMutation({
    mutationFn: (v: { roleId: number; permKeys: string[] }) => replaceRolePerms(v.roleId, v.permKeys),
    onSuccess: (_r, v) => {
      setReceipt('矩阵已保存（全量替换，' + v.permKeys.length + ' 个权限点）');
      void qc.invalidateQueries({ queryKey: qk.adminRoles() });
    },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });

  const err = roles.error ?? perms.error;
  return (
    <RolesScreen
      roles={roles.data ?? []}
      permissions={perms.data ?? []}
      loading={roles.isPending || perms.isPending}
      error={err ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          角色或权限点目录没能加载（HTTP {isApiError(err) ? err.status : 0}）：{errorLine(err)}
        </p>
      ) : null}
      canEdit={can(session.session, 'role.edit')}
      onSave={(roleId, permKeys) => save.mutate({ roleId, permKeys })}
      busy={save.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

