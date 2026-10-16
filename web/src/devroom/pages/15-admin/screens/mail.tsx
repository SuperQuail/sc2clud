import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import ProgressBar from '@jetbrains/ring-ui-built/components/progress-bar/progress-bar';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { KeyRound, Plus, Send } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { MailAccount, MailAccountInput } from '@/lib/api/admin';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';
import { NewAccountDialog } from './mail-new';
import { RotateSecretDialog } from './mail-cred';

// 13.9 发信账号管理（§8.2 + DB §4.8）。多账号按 priority 轮换，日额度用 mail_quota 记账。
// 凭据（secret_cipher）**只写不回读**：界面只能说「已配置 + 更新时间」，永远不显示密钥。
//
// **prop 驱动**：取数在 routes/admin-screens.tsx 的容器里。
//
// 三处与旧版（mock）不同、必须照后端来的：
//   ① **密钥只写不回显**（mail/dto.go 的 AdminAccount 只有 `secret_configured` + `secret_updated_at`）
//      —— 所以「编辑」里不出现密钥输入框的「当前值」，只有一个「换密钥」的写入口。
//   ② `PATCH` **只写传进来的字段**（AccountPatch 全是指针，nil = 不动）—— 所以每一项都是**显式保存**，
//      不是「改完一起提交」；没改的字段一个都不发。
//   ③ 测试发信要一个**收件地址**（`SendTestInput.to` 是 `binding:"required,email"`）：
//      必须由人填，**不能默认发给当前管理员**（那会把「测试」变成给人发垃圾邮件）。
//   ④ mock 里的 `status: 'active' | 'archived'` 是编的：后端的 `status` 是账号健康态字符串，
//      这里**原样显示**，不编中文标签。

export type MailScreenProps = {
  accounts: MailAccount[];
  loading?: boolean;
  error?: ReactNode;
  canManage: boolean;
  /** 新建账号（POST /admin/mail/accounts）。**这是全站唯一能配发信账号的入口**（账号不在配置文件里）。 */
  onCreate: (body: MailAccountInput) => void;
  /** 只改传进来的字段（PATCH 的语义：nil = 不动） */
  onPatch: (id: string, patch: { priority?: number; daily_limit?: number; from_name?: string; from_address?: string; reset_tz?: string; enabled?: boolean }) => void;
  /** 换凭据（PATCH 的 secret / options_json；只在换的那一次出现，后端据此刷新 secret_updated_at） */
  onSecret: (id: string, patch: { secret?: unknown; options_json?: unknown }) => void;
  onDelete: (id: string) => void;
  onTest: (id: string, to: string) => void;
  busy?: boolean;
  receipt?: ReactNode;
};

export function MailScreen({ accounts, loading = false, error = null, canManage, onCreate, onPatch, onSecret, onDelete, onTest, busy = false, receipt }: MailScreenProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [archive, setArchive] = useState<MailAccount | null>(null);
  const [testFor, setTestFor] = useState<MailAccount | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [rotateFor, setRotateFor] = useState<MailAccount | null>(null);

  const active = accounts.find((a) => a.id === activeId) ?? null;
  const sentToday = accounts.filter((a) => a.enabled).reduce((s, a) => s + a.sent_today, 0);
  // 「有账号」与「发得出去」是两件事：迁移过来的老账号密文被置 NULL（数据迁移审计 §3），
  // 它们会永远停在「未配置」而屏上看起来一切正常 —— 这正是 D26 说的「以为能发信」。
  const ready = accounts.filter((a) => a.enabled && a.secret_configured);
  const noUsable = ready.length === 0;

  const columns = [
    {
      key: 'name', title: '账号', track: 'minmax(152px,1.4fr)',
      render: (a: MailAccount) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='truncate text-[13px] font-medium text-foreground'>{a.name}</span>
          <span className='truncate text-[11px] text-muted-foreground'>{a.from_name ? a.from_name + ' ' : ''}&lt;{a.from_address}&gt;</span>
        </span>
      ),
    },
    { key: 'provider', title: 'provider', track: '78px', render: (a: MailAccount) => <Pill>{a.provider}</Pill> },
    {
      key: 'quota', title: '今日 / 日额度', track: 'minmax(136px,1.2fr)',
      render: (a: MailAccount) => (
        <span className='flex w-full min-w-0 flex-col gap-1'>
          <ProgressBar value={a.sent_today} max={Math.max(a.daily_limit, 1)} />
          <span className='text-[11px] text-muted-foreground'>{a.sent_today} / {a.daily_limit} · {a.reset_tz}</span>
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
          <Toggle checked={a.enabled} disabled={!canManage || busy} onChange={(e) => onPatch(a.id, { enabled: e.target.checked })}>
            {a.enabled ? '启用' : '停用'}
          </Toggle>
        </span>
      ),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(248px,1.6fr)',
      render: (a: MailAccount) => (
        <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
          <Button data-testid={'mail-cred-' + a.id} inline={false} height={ControlsHeight.S} icon={icon16(KeyRound)} disabled={!canManage || busy} onClick={() => setRotateFor(a)}>
            {a.secret_configured ? '换凭据' : '配凭据'}
          </Button>
          <Button inline={false} height={ControlsHeight.S} icon={icon16(Send)} disabled={!canManage || busy} onClick={() => setTestFor(a)}>测试发信</Button>
          <Button disabled={!canManage} onClick={() => setActiveId(a.id)}>编辑</Button>
          <DangerAction disabled={!canManage || busy} why={!canManage ? '本账号没有 mail.manage' : undefined} onClick={() => setArchive(a)}>删除</DangerAction>
        </span>
      ),
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='发信账号'
        note='多账号（provider 中立）、优先级轮换、日额度、启用/停用、测试发信；凭据加密存储且**只写不回读**。'
        actions={canManage ? (
          <Button data-testid='mail-create' inline={false} height={ControlsHeight.S} icon={icon16(Plus)} onClick={() => setCreateOpen(true)}>新增账号</Button>
        ) : null}
      />

      {noUsable && accounts.length > 0 ? (
        <p role='alert' data-testid='mail-no-usable' className='rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-foreground'>
          现在<strong>一封邮件都发不出去</strong>：没有一个「已启用 + 已配凭据」的账号。注册验证与找回密码都会失败
          （<code className='rounded-sm bg-muted px-1'>auth.mail_unavailable</code>）—— 点每一行的「换凭据」把密钥补上。
        </p>
      ) : null}

      <StatRow>
        <Stat label='账号' value={accounts.length} />
        <Stat label='启用中' value={accounts.filter((a) => a.enabled).length} tone='info' />
        <Stat label='今日已发' value={sentToday} hint='mail_quota 记账，跨天按 reset_tz 重置' />
        <Stat label='失败账号' value={accounts.filter((a) => a.last_error).length} tone='danger' />
        <Stat label='已配密钥' value={ready.length} hint='启用且已配凭据的才算（迁移过来的老账号密文置 NULL，要重填）' />
      </StatRow>

      {!canManage ? <GateNote perm='mail.manage'>整屏只读：本账号没有 mail.manage。</GateNote> : null}
      {receipt}
      {error}

      <DataTable
        columns={columns}
        rows={accounts}
        rowKey={(a) => a.id}
        rowLabel={(a) => a.name}
        activeKey={activeId}
        onRowClick={(a) => setActiveId(a.id)}
        loading={loading}
        minWidth={920}
        density='compact'
        empty='还没有发信账号'
      />

      <div className='grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_268px]'>
        <Panel title='账号详情' note='secret_cipher / secret_nonce 的界面表现：只有「已配置」与更新时间'>
          {active ? (
            <AccountForm key={active.id} account={active} canManage={canManage} busy={busy} onPatch={onPatch} onRotateSecret={setRotateFor} />
          ) : (
            <p className='text-[12px] text-muted-foreground'>在左侧点一行查看详情。</p>
          )}
        </Panel>

        <div className='flex flex-col gap-2'>
          <Panel title='轮换与冷却' note='按 priority 取第一个未超额度的账号；失败进冷却，不阻塞下一次发送'>
            <ol className='flex flex-col gap-1 text-[12px] text-muted-foreground'>
              <li>1 按 priority 降序挑账号</li>
              <li>2 跳过 enabled=false / 今日超额度 / 冷却中的</li>
              <li>3 失败写 last_error + 冷却窗口</li>
              <li>4 额度用 mail_quota(account_id, day) 记账</li>
            </ol>
            <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
              `status` 是账号健康态字符串，这一屏**原样显示**（不编中文标签，也不假设它只有两个值）。
            </p>
          </Panel>
          <Panel
            title='新建账号'
            actions={canManage ? <Button inline={false} height={ControlsHeight.S} icon={icon16(Plus)} onClick={() => setCreateOpen(true)}>新增</Button> : null}
          >
            <p className='text-[12px] text-muted-foreground'>
              `POST /admin/mail/accounts` 要 `name / provider / from_address` 三项必填，
              provider 值域 `resend | smtp | log`。**账号名与 provider 建后不可改**。
              账号不写进配置文件，也没有 CLI —— 这一个表单就是配发信账号的入口。
            </p>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={archive !== null}
        label='删除这个发信账号？'
        danger
        confirmText='删除账号'
        body={<span>删除 <b>{archive?.name}</b> 后它不再参与轮换；历史 mail_logs 保留可查（额度账也随之停止计数）。</span>}
        reasonLabel='删除理由（可选，进审计）'
        onClose={() => setArchive(null)}
        onConfirm={() => { if (archive) onDelete(archive.id); setArchive(null); }}
      />

      <TestSendDialog account={testFor} busy={busy} onClose={() => setTestFor(null)} onSend={onTest} />

      <NewAccountDialog show={createOpen} busy={busy} onClose={() => setCreateOpen(false)} onCreate={onCreate} />
      <RotateSecretDialog account={rotateFor} busy={busy} onClose={() => setRotateFor(null)} onSave={onSecret} />
    </div>
  );
}

/** 部分更新：**每一项显式保存**（PATCH 只写传进来的字段，nil = 不动）。 */
function AccountForm({ account, canManage, busy, onPatch, onRotateSecret }: {
  account: MailAccount;
  canManage: boolean;
  busy: boolean;
  onPatch: MailScreenProps['onPatch'];
  onRotateSecret: (account: MailAccount) => void;
}) {
  const [priority, setPriority] = useState(String(account.priority));
  const [dailyLimit, setDailyLimit] = useState(String(account.daily_limit));
  const [fromName, setFromName] = useState(account.from_name);
  const [fromAddress, setFromAddress] = useState(account.from_address);
  const dirty = priority !== String(account.priority) || dailyLimit !== String(account.daily_limit)
    || fromName !== account.from_name || fromAddress !== account.from_address;
  return (
    <>
      <Input label='账号名（不可改）' value={account.name} disabled onChange={() => {}} />
      <Input label='发信人地址' value={fromAddress} disabled={!canManage} onChange={(e) => setFromAddress(e.target.value)} />
      <Input label='发信人名称' value={fromName} disabled={!canManage} onChange={(e) => setFromName(e.target.value)} />
      <Input label='优先级（越大越先用）' value={priority} disabled={!canManage} onChange={(e) => setPriority(e.target.value)} />
      <Input label='日额度 daily_limit' value={dailyLimit} disabled={!canManage} onChange={(e) => setDailyLimit(e.target.value)} />
      <KV k='provider' v={account.provider} />
      <KV k='status' v={account.status || '—'} hint='后端原样给的健康态字符串' />
      <KV k='reset_tz' v={account.reset_tz || '—'} hint='额度按这个时区跨天重置' />
      <KV k='凭据' v={account.secret_configured ? '已配置' : '未配置'} hint={account.secret_updated_at ? fmtDate(account.secret_updated_at) + ' 更新' : '密钥永不回读'} />
      <KV k='最近成功' v={relTime(account.last_ok_at)} />
      <KV k='最近失败' v={account.last_error || '—'} />
      <div className='mt-2 flex justify-end gap-2'>
        <Button
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(KeyRound)}
          disabled={!canManage || busy}
          onClick={() => onRotateSecret(account)}
        >
          {account.secret_configured ? '换凭据' : '配凭据'}
        </Button>
        <Button disabled={!dirty} onClick={() => { setPriority(String(account.priority)); setDailyLimit(String(account.daily_limit)); setFromName(account.from_name); setFromAddress(account.from_address); }}>放弃</Button>
        <Button
          primary
          disabled={!canManage || !dirty || busy}
          onClick={() => {
            // 只发改过的字段 —— 没改的一个都不发（PATCH 的语义就是「出现的字段才写」）
            const patch: Parameters<MailScreenProps['onPatch']>[1] = {};
            if (priority !== String(account.priority)) patch.priority = Number(priority);
            if (dailyLimit !== String(account.daily_limit)) patch.daily_limit = Number(dailyLimit);
            if (fromName !== account.from_name) patch.from_name = fromName;
            if (fromAddress !== account.from_address) patch.from_address = fromAddress;
            onPatch(account.id, patch);
          }}
        >
          保存改动
        </Button>
      </div>
    </>
  );
}

/** 测试发信：**收件地址必须由人填**（后端 binding 要 email），不默认发给当前管理员。 */
function TestSendDialog({ account, busy, onClose, onSend }: {
  account: MailAccount | null;
  busy: boolean;
  onClose: () => void;
  onSend: (id: string, to: string) => void;
}) {
  const [to, setTo] = useState('');
  if (!account) return null;
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim());
  return (
    <Dialog show label='测试发信' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        <p className='text-[13px] text-foreground'>
          用 <b>{account.name}</b> 发一封测试信。<b>收件地址必须自己填</b>：默认发给当前管理员
          会把「测试」变成给人发垃圾邮件，而且看不出这个账号到底通不通。
        </p>
        <Input label='收件地址' value={to} onChange={(e) => setTo(e.target.value)} placeholder='you@example.com' />
        <div className='flex justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Button primary disabled={!ok || busy} onClick={() => { onSend(account.id, to.trim()); onClose(); }}>发送测试信</Button>
        </div>
      </div>
    </Dialog>
  );
}

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.round(hours / 24);
  return days < 31 ? days + ' 天前' : iso.slice(0, 10);
}
