import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  fetchMailTemplates,
  previewMailTemplate,
  resetMailTemplate,
  saveMailTemplate,
} from '@/lib/api/admin';
import type { MailTemplatePreview } from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { MailTemplateScreen } from '@/devroom/pages/15-admin/screens/mail-tpl';

// ── 屏 mailtpl：邮件模板（D37）────────────────────────────────────────────
// 依赖 GET /admin/mail-templates 与 PUT/DELETE /admin/mail-templates/{kind}、POST /admin/mail-templates/preview。
// 权限点 site.setting（routes/admin.tsx 的 PERM_BY_SCREEN 照后端 authz 抄）。
//
// 「恢复内置」= DELETE；保存与预览被拒时把 error.fields 对到编辑框（后端错误原话带行位）。
export function MailTemplateScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [preview, setPreview] = useState<MailTemplatePreview | null>(null);
  const [fields, setFields] = useState<Record<string, string> | null>(null);

  const list = useQuery({ queryKey: qk.adminMailTemplates(), queryFn: ({ signal }) => fetchMailTemplates(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.adminMailTemplates() });

  const save = useMutation({
    mutationFn: (v: { kind: string; body: { subject: string; html_body: string; text_body: string } }) => saveMailTemplate(v.kind, v.body),
    onSuccess: (t) => {
      setFields(null);
      setPreview(null);
      setReceipt('已保存「' + t.kind + '」的三段模板源 —— 下一次投递就用它（编译校验已通过）');
      refresh();
    },
    onError: (e) => {
      setFields(isApiError(e) && e.fields ? (e.fields as Record<string, string>) : null);
      setReceipt('保存被拒：模板要编译通过才能入库（' + (errorLine(e) ?? '') + '）');
    },
  });

  const reset = useMutation({
    mutationFn: (kind: string) => resetMailTemplate(kind),
    onSuccess: () => {
      setFields(null);
      setPreview(null);
      setReceipt('已恢复内置模板 —— 下一次投递落回系统内置');
      refresh();
    },
    onError: (e) => setReceipt('恢复内置失败：' + (errorLine(e) ?? '')),
  });

  const previewMut = useMutation({
    mutationFn: (v: { kind: string; body: { subject?: string; html_body?: string; text_body?: string } }) =>
      previewMailTemplate({ kind: v.kind, ...v.body }),
    onSuccess: (p) => {
      setFields(null);
      setPreview(p);
      setReceipt('已按样本数据渲染编辑框里这份（未保存；站点名取自站点设置）');
    },
    onError: (e) => {
      setFields(isApiError(e) && e.fields ? (e.fields as Record<string, string>) : null);
      setPreview(null);
      setReceipt('预览被拒：' + (errorLine(e) ?? ''));
    },
  });

  return (
    <MailTemplateScreen
      templates={list.data ?? []}
      loading={list.isPending}
      error={list.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          邮件模板没能加载（HTTP {isApiError(list.error) ? list.error.status : 0}）：{errorLine(list.error)}
        </p>
      ) : null}
      canManage={can(session.session, 'site.setting')}
      fields={fields}
      onSave={(kind, body) => save.mutate({ kind, body })}
      onReset={(kind) => reset.mutate(kind)}
      onPreview={(kind, body) => previewMut.mutate({ kind, body })}
      preview={preview}
      previewBusy={previewMut.isPending}
      busy={save.isPending || reset.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}
