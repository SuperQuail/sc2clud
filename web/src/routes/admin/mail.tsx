import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import {
  createMailAccount,
  deleteMailAccount,
  fetchMailAccounts,
  testMailAccount,
  updateMailAccount,
} from '@/lib/api/admin';
import { isApiError } from '@/lib/api/errors';
import { can, useSession } from '@/lib/perms';
import { errorLine } from './_shared';
import { MailScreen } from '@/devroom/pages/15-admin/screens/mail';

// ── 屏 h：发信账号 ────────────────────────────────────────────────────────
// 依赖 GET/POST/PATCH/DELETE /admin/mail/accounts 与 POST /admin/mail/accounts/{id}/test（都已在）。

export function MailScreenContainer() {
  const qc = useQueryClient();
  const session = useSession();
  const [receipt, setReceipt] = useState<string | null>(null);

  const list = useQuery({ queryKey: qk.adminMail(), queryFn: ({ signal }) => fetchMailAccounts(signal) });
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.adminMail() });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Parameters<typeof updateMailAccount>[1] }) => updateMailAccount(v.id, v.body),
    onSuccess: (a, v) => { setReceipt('已保存「' + a.name + '」的 ' + Object.keys(v.body).join('、')); refresh(); },
    onError: (e) => setReceipt('保存失败：' + (errorLine(e) ?? '')),
  });
  // 建账号：secret 只在这一次请求里出现 —— 后端加密入库，之后再也读不回来（mail/dto.go 的 AdminAccount 没有这两个字段）。
  const create = useMutation({
    mutationFn: createMailAccount,
    onSuccess: (a) => { setReceipt('已新建账号「' + a.name + '」（' + a.provider + '）' + (a.secret_configured ? '，凭据已加密入库' : '；还没有凭据，它现在发不出信')); refresh(); },
    onError: (e) => setReceipt('新建失败：' + (errorLine(e) ?? '')),
  });
  // 换凭据 / 换 SMTP 的 host（PATCH 的 secret + options_json）。凭据只写不回读：
  // 成功后界面只能确认「已配置 + 更新时间」，那封信通不通要按「测试发信」才知道。
  const rotate = useMutation({
    mutationFn: (v: { id: string; body: { secret?: unknown; options_json?: unknown } }) => updateMailAccount(v.id, v.body),
    onSuccess: (a) => { setReceipt('已更新「' + a.name + '」的凭据（' + (a.secret_updated_at ? a.secret_updated_at.slice(0, 10) : '刚写入') + '）—— 通不通要按「测试发信」才知道'); refresh(); },
    onError: (e) => setReceipt('换凭据失败：' + (errorLine(e) ?? '')),
  });
  const remove = useMutation({
    mutationFn: deleteMailAccount,
    onSuccess: (r) => { setReceipt(r.archived ? '账号已归档' : '账号已删除'); refresh(); },
    onError: (e) => setReceipt('删除失败：' + (errorLine(e) ?? '')),
  });
  const test = useMutation({
    mutationFn: (v: { id: string; to: string }) => testMailAccount(v.id, v.to),
    onSuccess: (r) => { setReceipt('已入队一封测试信（mail_log_id=' + r.mail_log_id + '）——「入队成功」不等于「对方收到了」，去 mail_logs 看结果'); refresh(); },
    onError: (e) => setReceipt('测试发信失败：' + (errorLine(e) ?? '')),
  });

  return (
    <MailScreen
      accounts={list.data ?? []}
      loading={list.isPending}
      error={list.error ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          发信账号没能加载（HTTP {isApiError(list.error) ? list.error.status : 0}）：{errorLine(list.error)}
        </p>
      ) : null}
      canManage={can(session.session, 'mail.manage')}
      onCreate={(body) => create.mutate(body)}
      onPatch={(id, body) => patch.mutate({ id, body })}
      onSecret={(id, body) => rotate.mutate({ id, body })}
      onDelete={(id) => remove.mutate(id)}
      onTest={(id, to) => test.mutate({ id, to })}
      busy={create.isPending || patch.isPending || rotate.isPending || remove.isPending || test.isPending}
      receipt={receipt ? (
        <p role='status' className='rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-foreground'>{receipt}</p>
      ) : null}
    />
  );
}

