import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import ProgressBar from '@jetbrains/ring-ui-built/components/progress-bar/progress-bar';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { Send } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';
import { fmtDate, MAIL_ACCOUNTS, relTime, type MailAccount } from '../mock';
import { useCan } from '../mock/perms';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';

// 13.9 发信账号管理（§8.2 + DB §4.8）。多账号按 priority 轮换，日额度用 mail_quota 记账。
// 凭据（secret_cipher）**只写不回读**：界面只能说「已配置 + 更新时间」，永远不显示密钥。
export function MailScreen() {
  const canMail = useCan('mail.manage');
  const canSystem = useCan('system.settings');
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(MAIL_ACCOUNTS.map((a) => [a.id, a.enabled])));
  const [testing, setTesting] = useState<string | null>(null);
  const [archive, setArchive] = useState<MailAccount | null>(null);
  const [activeId, setActiveId] = useState<string | null>(MAIL_ACCOUNTS[0]!.id);

  const rows = MAIL_ACCOUNTS.map((a) => ({ ...a, enabled: enabled[a.id] ?? a.enabled }));
  const active = rows.find((a) => a.id === activeId) ?? null;
  const sentToday = rows.filter((a) => a.status === 'active').reduce((s, a) => s + a.sent_today, 0);

  const columns = [
    {
      key: 'name', title: '账号', track: 'minmax(152px,1.4fr)',
      render: (a: MailAccount) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='truncate text-[13px] font-medium text-foreground'>{a.name}</span>
          <span className='truncate text-[11px] text-muted-foreground'>{a.from_name} &lt;{a.from_address}&gt;</span>
        </span>
      ),
    },
    { key: 'provider', title: 'provider', track: '78px', render: (a: MailAccount) => <Pill>{a.provider}</Pill> },
    {
      key: 'quota', title: '今日 / 日额度', track: 'minmax(136px,1.2fr)',
      render: (a: MailAccount) => (
        <span className='flex w-full min-w-0 flex-col gap-1'>
          <ProgressBar value={a.sent_today} max={a.daily_limit} />
          <span className='text-[11px] text-muted-foreground'>{a.sent_today} / {a.daily_limit}</span>
        </span>
      ),
    },
    {
      key: 'secret', title: '凭据', track: 'minmax(104px,1fr)',
      render: (a: MailAccount) => (a.secret_configured
        ? <span className='flex flex-col leading-tight'><Pill tone='ok'>已配置</Pill><span className='text-[10px] text-muted-foreground'>{fmtDate(a.secret_updated_at)} 更新</span></span>
        : <Pill tone='danger'>未配置</Pill>),
    },
    {
      key: 'health', title: '最近结果', track: 'minmax(126px,1.2fr)',
      render: (a: MailAccount) => (a.last_error
        ? <span className='flex min-w-0 flex-col leading-tight'><Pill tone='danger'>失败 {relTime(a.last_error_at)}</Pill><span className='truncate text-[10px] text-muted-foreground'>{a.last_error}</span></span>
        : <span className='text-[12px] text-muted-foreground'>成功 {relTime(a.last_ok_at)}</span>),
    },
    {
      key: 'enabled', title: '启用', track: '84px',
      render: (a: MailAccount) => (
        <span className='flex items-center' onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={a.enabled}
            disabled={!canMail || a.status === 'archived'}
            onChange={(e) => setEnabled((p) => ({ ...p, [a.id]: e.target.checked }))}
          >
            {a.enabled ? '启用' : '停用'}
          </Toggle>
        </span>
      ),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(172px,1.3fr)',
      render: (a: MailAccount) => (
        <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
          <Button
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(Send)}
            loader={testing === a.id}
            disabled={!canMail || a.status === 'archived'}
            onClick={() => { setTesting(a.id); window.setTimeout(() => setTesting(null), 900); }}
          >
            测试发信
          </Button>
          <Button disabled={!canMail} onClick={() => setActiveId(a.id)}>编辑</Button>
          <DangerAction
            disabled={!canMail || a.status === 'archived'}
            why={a.status === 'archived' ? '已经归档' : undefined}
            onClick={() => setArchive(a)}
          >
            归档
          </DangerAction>
        </span>
      ),
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='发信账号'
        note='13.9：多账号（provider 中立）、优先级轮换、日额度、启用/归档、测试发信；凭据加密存储且只写不回读。'
      />

      <StatRow>
        <Stat label='账号' value={rows.length} />
        <Stat label='启用中' value={rows.filter((a) => a.enabled && a.status === 'active').length} tone='info' />
        <Stat label='今日已发' value={sentToday} hint='mail_quota 记账，跨天按 reset_tz 重置' />
        <Stat label='失败账号' value={rows.filter((a) => a.last_error).length} tone='danger' />
      </StatRow>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        rowLabel={(a) => a.name}
        activeKey={activeId}
        onRowClick={(a) => setActiveId(a.id)}
        minWidth={872}
        density='compact'
        empty='还没有发信账号'
      />

      <div className='grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_268px]'>
        <Panel title='账号详情' note='secret_cipher / secret_nonce 的界面表现：只有「已配置」与更新时间'>
          {active ? (
            <>
              <Input label='账号名' defaultValue={active.name} disabled={!canMail} />
              <Input label='发信人地址' defaultValue={active.from_address} disabled={!canMail} />
              <Input label='发信人名称' defaultValue={active.from_name} disabled={!canMail} />
              <Input label='优先级（越大越先用）' defaultValue={String(active.priority)} disabled={!canMail} />
              <Input label='日额度 daily_limit' defaultValue={String(active.daily_limit)} disabled={!canMail} />
              <KV k='provider' v={active.provider} />
              <KV k='reset_tz' v='Asia/Shanghai' hint='额度按这个时区跨天重置' />
              <KV k='凭据' v={active.secret_configured ? '已配置' : '未配置'} hint={active.secret_updated_at ? fmtDate(active.secret_updated_at) + ' 更新' : '密钥永不回读'} />
              <KV k='最近成功' v={relTime(active.last_ok_at)} />
              <KV k='最近失败' v={active.last_error ?? '—'} />
            </>
          ) : (
            <p className='text-[12px] text-muted-foreground'>在左侧点一行查看详情。</p>
          )}
        </Panel>

        <div className='flex flex-col gap-2'>
          <Panel title='轮换与冷却' note='§8.3：按 priority 取第一个未超额度的账号；失败进冷却，不阻塞下一次发送'>
            <ol className='flex flex-col gap-1 text-[12px] text-muted-foreground'>
              <li>1 按 priority 降序挑账号</li>
              <li>2 跳过 enabled=false / 已归档 / 今日超额度 / 冷却中的</li>
              <li>3 失败写 last_error + 冷却窗口</li>
              <li>4 额度用 mail_quota(account_id, day) 记账</li>
            </ol>
          </Panel>
          <Panel title='系统级发信配置'>
            {canSystem ? (
              <p className='text-[12px] text-muted-foreground'>（本页不重复实现：站点设置屏里是 mail.enabled 与 mail.from_name）</p>
            ) : (
              <GateNote perm='system.settings'>
                「轮换密钥 / 重置冷却窗口 / 全局发信开关」不渲染：这些属系统级配置，本账号没有 system.settings。
              </GateNote>
            )}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={archive !== null}
        label='归档这个发信账号？'
        danger
        confirmText='归档账号'
        body={<span>归档 <b>{archive?.name}</b> 后它不再参与轮换；历史 mail_logs 保留可查（额度账也随之停止计数）。</span>}
        reasonLabel='归档理由（可选，进审计）'
        onClose={() => setArchive(null)}
        onConfirm={() => { if (archive) setEnabled((p) => ({ ...p, [archive.id]: false })); setArchive(null); }}
      />
    </div>
  );
}