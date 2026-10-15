import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  createTitle,
  fetchTitles,
  updateTitle,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { TitlesScreen } from '@/devroom/pages/15-admin/screens/titles';

// ── 屏 g：头衔目录 ────────────────────────────────────────────────────────
// 依赖 GET/POST /admin/titles 与 PATCH /admin/titles/{id}（三条都已在，权限点 title.manage）。

export function TitlesScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);

  const list = useQuery({ queryKey: qk.adminTitles(), queryFn: ({ signal }) => fetchTitles(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.adminTitles() });
  // PATCH 的 body 是**全字段**（title/handler.go 的 titleBody），所以改一个字段也要把其余原样带上。
  const create = useMutation({
    mutationFn: createTitle,
    onSuccess: (t) => { setReceipt('已新建头衔「' + t.name + '」'); refresh(); },
    onError: (e) => setReceipt('新建失败：' + (errorLine(e) ?? '')),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; body: { key: string; name: string; color: string; description: string; archived: boolean } }) =>
      updateTitle(v.id, v.body),
    onSuccess: (t) => { setReceipt('已保存「' + t.name + '」' + (t.archived_at ? '（已归档）' : '')); refresh(); },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });

  return (
    <TitlesScreen
      titles={list.data ?? []}
      loading={list.isPending}
      error={list.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          头衔目录没能加载（HTTP {isApiError(list.error) ? list.error.status : 0}）：{errorLine(list.error)}
        </p>
      ) : null}
      canManage={can(session.session, 'title.manage')}
      // 返回 Promise<boolean>：屏据此**只在建成时关窗**；失败时把理由留在弹窗里（输入不丢）。
      // 先 reset 再打，否则上一次的 error 会留在屏上。
      onCreate={(b) => {
        create.reset();
        return create.mutateAsync(b).then(
          () => true,
          () => false,
        );
      }}
      createError={create.error ? errorLine(create.error) : null}
      onUpdate={(id, body) => update.mutate({ id, body })}
      busy={create.isPending || update.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

