import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { DisabledReason } from '../bits';

// 发信凭据（mail_accounts.secret_cipher）的**写入口**：平台侧 creds 的形状
// （platform/mail/provider.go 的 creds / smtpOptions）——
//   resend: {"api_key"}
//   smtp:   {"username","password"} + options_json 的 {"host","port","tls"}（非敏感，明文存）
//   log:    不需要凭据（凭据只用来让 HasUsable 判定「这个账号可用」）
// **只写不回读**：后端 DTO 里根本没有 secret 字段（mail/dto.go 的 AdminAccount），
// 所以这里永远没有「当前值」可显示，只有「已配置 / 未配置」与更新时间（由调用方画）。

export type MailCred = { apiKey: string; username: string; password: string; host: string; port: string };
export const EMPTY_CRED: MailCred = { apiKey: '', username: '', password: '', host: '', port: '' };

export const PROVIDERS = [
  { key: 'resend', label: 'resend（HTTP API，主力通道）' },
  { key: 'smtp', label: 'smtp（自建/第三方 SMTP）' },
  { key: 'log', label: 'log（把整封信写进日志，只能配在 dev/测试）' },
];

/** 判「这个 provider 的凭据填齐了没有」。返回空串 = 可以提交，否则是要显示的缺项。 */
export function credMissing(provider: string, c: MailCred): string {
  if (provider === 'resend' && c.apiKey.trim() === '') return 'resend 的 api_key 必填';
  if (provider === 'smtp') {
    if (c.host.trim() === '') return 'smtp 必须填 host（options_json.host）';
    if (c.username.trim() === '' || c.password === '') return 'smtp 必须填 username 与 password';
  }
  return '';
}

/** 把表单拼成请求体（**空值一个都不发**：PATCH 的语义是「出现的字段才写」）。 */
export function credPatch(provider: string, c: MailCred): { secret?: unknown; options_json?: unknown } {
  if (provider === 'resend') return { secret: { api_key: c.apiKey.trim() } };
  if (provider === 'smtp') {
    const options: Record<string, unknown> = { host: c.host.trim() };
    if (c.port.trim() !== '') options.port = Number(c.port);
    return { secret: { username: c.username.trim(), password: c.password }, options_json: options };
  }
  return {};
}

/** 凭据字段行：provider 决定画哪几个（resend / smtp / log 三套）。 */
export function CredFields({ provider, value, onChange }: {
  provider: string;
  value: MailCred;
  onChange: (next: MailCred) => void;
}) {
  const set = (patch: Partial<MailCred>) => onChange({ ...value, ...patch });
  if (provider === 'resend') {
    return (
      <Input
        label='api_key（Resend 的密钥）'
        size={Size.FULL}
        value={value.apiKey}
        onChange={(e) => set({ apiKey: e.target.value })}
        help='只写不回读：存进去以后界面只能告诉你「已配置」与更新时间'
      />
    );
  }
  if (provider === 'smtp') {
    return (
      <>
        <Input label='host' size={Size.FULL} value={value.host} onChange={(e) => set({ host: e.target.value })} placeholder='smtp.example.com' />
        <Input
          label='port（可空 = 587）'
          size={Size.FULL}
          value={value.port}
          onChange={(e) => set({ port: e.target.value.replace(/[^0-9]/g, '') })}
          help='starttls 走 587，隐式 TLS 走 465'
        />
        <Input label='username' size={Size.FULL} value={value.username} onChange={(e) => set({ username: e.target.value })} />
        <Input
          label='password'
          size={Size.FULL}
          type='password'
          value={value.password}
          onChange={(e) => set({ password: e.target.value })}
        />
      </>
    );
  }
  return (
    <DisabledReason>
      log provider 不需要凭据，它把整封信（含 6 位验证码）写进服务端日志 —— 只能配在 dev / 测试实例，
      生产库里出现 provider=log 的账号等于把验证码写进日志。
    </DisabledReason>
  );
}

/**
 * 换某一行已有的凭据（PATCH 的 secret / options_json）。
 * provider **改不了**（后端 AccountPatch 里没有 provider 字段）——所以行上把当前 provider 显示出来。
 */
export function RotateSecretDialog({ account, busy, onClose, onSave }: {
  account: { id: string; name: string; provider: string } | null;
  busy: boolean;
  onClose: () => void;
  onSave: (id: string, patch: { secret?: unknown; options_json?: unknown }) => void;
}) {
  const [cred, setCred] = useState<MailCred>(EMPTY_CRED);
  if (!account) return null;
  const provider = account.provider;
  const missing = credMissing(provider, cred);
  const close = () => { setCred(EMPTY_CRED); onClose(); };
  return (
    <Dialog show label='换凭据' onCloseAttempt={close} onOverlayClick={close} onEscPress={close}>
      <div className='flex w-[460px] max-w-full flex-col gap-3 p-4'>
        <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
          给 <b>{account.name}</b> 换一份凭据（provider 固定为 <code className='rounded-sm bg-muted px-1'>{provider}</code>：
          它是建账号时定的，后端没有改名/改 provider 的入口）。旧凭据被覆盖，<code className='rounded-sm bg-muted px-1'>secret_updated_at</code> 随之刷新。
        </p>
        <CredFields provider={provider} value={cred} onChange={setCred} />
        {missing !== '' ? <DisabledReason>{missing}</DisabledReason> : null}
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={close}>取消</Button>
          <Button
            primary
            disabled={missing !== '' || busy}
            onClick={() => { onSave(account.id, credPatch(provider, cred)); close(); }}
          >
            保存凭据
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
