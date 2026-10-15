import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Radio from '@jetbrains/ring-ui-built/components/radio/radio';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import type { MailAccountInput } from '@/lib/api/admin';
import { DisabledReason } from '../bits';
import { CredFields, EMPTY_CRED, PROVIDERS, credMissing, credPatch, type MailCred } from './mail-cred';

// 新增发信账号（POST /admin/mail/accounts，权限点 mail.manage）。
//
// 它是**这条链上唯一能配账号的地方**：账号不写配置文件、不写环境变量，也没有 CLI
//（技术方案 v2 §8.2「管理员在后台增删改，改完立刻生效」）。所以少了这个表单，
// 生产上就一个发信账号都建不出来 —— 表现是注册直接 503 auth.mail_unavailable、
// 而管理端只能看着一张空表（D26 的「无法新增账户」）。
//
// 为什么是弹层：`name`（唯一）与 `provider`（建后不可改）都是**建下去就改不了**的字段，
// 先在弹层里定下来，比建完再回来发现要重来安全 —— 与 boards-new.tsx 同一个理由。

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function NewAccountDialog({ show, busy, onClose, onCreate }: {
  show: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (body: MailAccountInput) => void;
}) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('resend');
  const [cred, setCred] = useState<MailCred>(EMPTY_CRED);
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [priority, setPriority] = useState('0');
  const [dailyLimit, setDailyLimit] = useState('100');
  const [resetTZ, setResetTZ] = useState('');
  const [enabled, setEnabled] = useState(true);
  if (!show) return null;

  // 与后端 binding 对齐的三条必填（mail/dto.go 的 AccountInput）+ 一眼能看出的格式问题
  const badName = name.trim() === '';
  const badFrom = !EMAIL.test(fromAddress.trim());
  const missing = credMissing(provider, cred);
  const badPriority = priority.trim() !== '' && Number(priority) < 0;
  const badLimit = dailyLimit.trim() === '' || Number(dailyLimit) < 1;
  const blocked = badName || badFrom || missing !== '' || badPriority || badLimit;

  const reset = () => {
    setName(''); setProvider('resend'); setCred(EMPTY_CRED); setFromAddress(''); setFromName('');
    setPriority('0'); setDailyLimit('100'); setResetTZ(''); setEnabled(true);
  };
  return (
    <Dialog show label='新增发信账号' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[520px] max-w-full flex-col gap-3 p-4'>
        <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
          账号存在库里、由后台维护（技术方案 v2 §8.2）：改完立刻生效，不用改配置、不用重启。
          <b> 账号名与 provider 建后不可改</b> —— 要换就新建一个再把旧的归档。
        </p>
        <Input label='账号名（唯一，建后不可改）' size={Size.FULL} value={name} onChange={(e) => setName(e.target.value)} placeholder='main-resend' />
        {/* provider 用 Radio 而不是下拉：三个值都摆出来（选错 provider 建完就改不了），
           且出图/断言时不用去点一个渲染在别处浮层里的下拉。必须 Radio.Item ——
           Radio 本身不渲染 DOM（registry.ts 的 radio 条目）。 */}
        <span data-testid='mail-new-provider' className='flex flex-wrap items-center gap-x-6 gap-y-2'>
          {PROVIDERS.map((p) => (
            <Radio.Item
              key={p.key}
              name='mail-provider'
              value={p.key}
              checked={provider === p.key}
              onChange={() => { setProvider(p.key); setCred(EMPTY_CRED); }}
            >
              {p.label}
            </Radio.Item>
          ))}
        </span>
        <CredFields provider={provider} value={cred} onChange={setCred} />
        <Input
          label='发件人地址'
          size={Size.FULL}
          value={fromAddress}
          onChange={(e) => setFromAddress(e.target.value)}
          placeholder='noreply@sc2clud.example'
          error={fromAddress !== '' && badFrom ? '必须是合法邮箱（后端 binding 要 email）' : undefined}
        />
        <Input label='发件人名称' size={Size.FULL} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder='SC2clud' />
        <Input
          label='优先级（越大越先用）'
          size={Size.FULL}
          value={priority}
          onChange={(e) => setPriority(e.target.value.replace(/[^0-9]/g, ''))}
          error={badPriority ? '不能为负' : undefined}
        />
        <Input
          label='日额度 daily_limit'
          size={Size.FULL}
          value={dailyLimit}
          onChange={(e) => setDailyLimit(e.target.value.replace(/[^0-9]/g, ''))}
          error={badLimit ? '必须大于 0' : undefined}
          help='每次投递占 1；跨自然日按下面的时区重置'
        />
        <Input
          label='reset_tz（可空 = 后端默认 Asia/Shanghai）'
          size={Size.FULL}
          value={resetTZ}
          onChange={(e) => setResetTZ(e.target.value)}
          placeholder='Asia/Shanghai'
          help='额度按这个时区的自然日重置；填了必须是合法 IANA 时区名，否则后端 400'
        />
        <Toggle checked={enabled} onChange={(e) => setEnabled(e.target.checked)}>启用（建完就参与轮换）</Toggle>
        {blocked ? <DisabledReason>账号名、合法发件人地址、以及这个 provider 需要的凭据都填齐才能创建</DisabledReason> : null}
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={() => { reset(); onClose(); }}>取消</Button>
          <Button
            primary
            disabled={blocked || busy}
            onClick={() => {
              const body: MailAccountInput = {
                name: name.trim(),
                provider,
                from_address: fromAddress.trim(),
                from_name: fromName.trim(),
                priority: Number(priority),
                daily_limit: Number(dailyLimit),
                enabled,
                ...credPatch(provider, cred),
              };
              if (resetTZ.trim() !== '') body.reset_tz = resetTZ.trim();
              onCreate(body);
              reset();
              onClose();
            }}
          >
            创建账号
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
