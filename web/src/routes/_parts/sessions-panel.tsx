import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/devroom/pages/15-admin/confirm';
import { formatMinute, formatTime } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { apiErrorLine, isApiError } from '@/lib/api/errors';
import { fetchSessions, revokeSession, type DeviceSession } from '@/lib/api/auth';
import { ErrorState, Loading } from './state';

// 登录设备（GET /me/sessions + DELETE /me/sessions/{id}）——设置页那一格。
// 真源 auth.SessionItem（forum/internal/auth/service.go:235）：id / ip / user_agent / last_seen_at /
// created_at / is_current，**不回 token、不回 token_hash**（所以界面上也没有任何可复制的凭据）。
//
// 「退出该设备」是**不可撤销**的动作：那台设备上的 Cookie 立刻失效、要重新登录。
// 走二次确认弹层（ConfirmDialog 是 DevRoom 15-admin 验证过、后台各屏在用的那一个）——
// 撤**当前这一台** = 本页当场掉线，所以确认文案分两种，第二种明说这件事；
// 成功后连 /me 一起失效：会话已经没了，界面不能停在「还登录着」的假象上。
export function SessionsPanel() {
  const qc = useQueryClient();
  const [target, setTarget] = useState<DeviceSession | null>(null);
  const list = useQuery({ queryKey: qk.sessions(), queryFn: ({ signal }) => fetchSessions(signal) });
  const revoke = useMutation({
    mutationFn: (s: DeviceSession) => revokeSession(s.id),
    onSuccess: (_r, s) => {
      setTarget(null);
      void qc.invalidateQueries({ queryKey: qk.sessions() });
      if (s.is_current) void qc.invalidateQueries({ queryKey: qk.me() });
    },
  });

  if (list.isPending) return <Loading what='登录设备' className='py-10' />;
  if (list.isError) {
    return <ErrorState what='登录设备' error={list.error} onRetry={() => void list.refetch()} />;
  }
  const rows = list.data ?? [];

  return (
    <section
      data-testid='sessions-panel'
      className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'
    >
      <h2 className='m-0 text-[15px] font-semibold text-foreground'>登录设备</h2>
      <span className='text-[11px] leading-relaxed text-muted-foreground'>
        这里是你账号正在用的浏览器会话。退出某台设备后，那台设备上的登录立刻失效、要重新登录才能再用 ——
        这一步不可撤销（想一次全退掉就去上面改密码）。
      </span>
      {revoke.isError ? (
        <p role='alert' className='m-0 text-[12px] text-destructive'>
          退出失败：{isApiError(revoke.error) ? apiErrorLine(revoke.error) : String(revoke.error)}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <span className='text-[12px] text-muted-foreground'>当前没有可显示的会话。</span>
      ) : (
        <ul className='m-0 flex list-none flex-col gap-2 p-0'>
          {rows.map((s) => (
            <li
              key={s.id}
              data-testid='session-row'
              className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2'
            >
              <span className='flex min-w-0 flex-col gap-0.5'>
                <span className='flex flex-wrap items-center gap-2'>
                  <span className='truncate text-[13px] text-foreground'>{s.user_agent || '未知客户端'}</span>
                  {s.is_current ? (
                    <span className='rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground'>当前设备</span>
                  ) : null}
                </span>
                <span className='text-[11px] text-muted-foreground'>
                  {s.ip || '未知 IP'} · 最后活跃 {formatTime(s.last_seen_at)} · 登录于 {formatMinute(s.created_at)}
                </span>
              </span>
              <Button
                data-testid={'session-revoke-' + s.id}
                danger
                inline={false}
                height={ControlsHeight.S}
                disabled={revoke.isPending}
                onClick={() => setTarget(s)}
              >
                退出该设备
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        show={target !== null}
        label='退出这台设备？'
        confirmText='退出该设备'
        danger
        body={
          target?.is_current ? (
            <span>这是你当前正在用的那一台。退出后本页会立刻变成未登录，要重新登录才能继续。</span>
          ) : (
            <span>退出后，那台设备上的登录立刻失效，要重新登录才能再用。这一步不可撤销。</span>
          )
        }
        onClose={() => setTarget(null)}
        onConfirm={() => {
          if (target) revoke.mutate(target);
        }}
      />
    </section>
  );
}
