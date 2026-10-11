import { useState } from 'react'
import {
  archiveMailAccount,
  createMailAccount,
  saveMailSettings,
  setMailAccountEnabled,
  testMailAccount,
  updateMailAccount,
  type AdminMailData,
  type MailAccount,
  type MailAccountInput,
  type MailSettings,
} from '../lib/admin'
import { Button } from './Button'
import { Field } from './Field'
import { Input } from './Input'
import { SelectBox } from './Select'

const errText = (e: unknown) => (e instanceof Error ? e.message : '请求失败')

function relative(now: number, ts: number): string {
  if (!ts) return '从未'
  const delta = Math.max(0, now - ts)
  if (delta < 60) return '刚刚'
  if (delta < 3600) return Math.floor(delta / 60) + ' 分钟前'
  if (delta < 86400) return Math.floor(delta / 3600) + ' 小时前'
  return Math.floor(delta / 86400) + ' 天前'
}

function untilText(now: number, ts: number): string {
  const delta = Math.max(0, ts - now)
  if (delta < 60) return delta + ' 秒'
  if (delta < 3600) return Math.ceil(delta / 60) + ' 分钟'
  return Math.ceil(delta / 3600) + ' 小时'
}

type Tone = 'ok' | 'warn' | 'bad' | 'off'

/** 一个账号当前处于什么状态 —— 这是多 key 运维唯一真正要看的信息。 */
function statusOf(account: MailAccount, now: number): { tone: Tone; label: string } {
  if (account.archived) return { tone: 'off', label: '已归档' }
  if (!account.enabled) return { tone: 'off', label: '已停用' }
  if (!account.secretSet) return { tone: 'bad', label: '未配密钥' }
  if (account.cooldownUntil > now) {
    return { tone: 'warn', label: '冷却中 ' + untilText(now, account.cooldownUntil) }
  }
  if (account.lastErrorAt > account.lastOkAt) return { tone: 'warn', label: '上次失败' }
  if (!account.lastOkAt) return { tone: 'off', label: '还没发过' }
  return { tone: 'ok', label: '正常' }
}

interface Draft {
  provider: string
  label: string
  priority: string
  fromAddress: string
  fromName: string
  replyTo: string
  baseUrl: string
  dailyQuota: string
  enabled: boolean
  secret: string
}

function emptyDraft(provider: string): Draft {
  return {
    provider,
    label: '',
    priority: '100',
    fromAddress: '',
    fromName: '',
    replyTo: '',
    baseUrl: '',
    dailyQuota: '100',
    enabled: true,
    secret: '',
  }
}

function draftOf(account: MailAccount): Draft {
  return {
    provider: account.provider,
    label: account.label,
    priority: String(account.priority),
    fromAddress: account.fromAddress,
    fromName: account.fromName,
    replyTo: account.replyTo,
    baseUrl: String(account.options.base_url ?? ''),
    dailyQuota: String(account.dailyQuota),
    enabled: account.enabled,
    // 密钥永不回显：留空即不改。
    secret: '',
  }
}

function toInput(draft: Draft): MailAccountInput {
  return {
    provider: draft.provider,
    label: draft.label,
    priority: Number(draft.priority) || 0,
    fromAddress: draft.fromAddress,
    fromName: draft.fromName,
    replyTo: draft.replyTo,
    optionsJson: JSON.stringify({ base_url: draft.baseUrl.trim() }),
    dailyQuota: Number(draft.dailyQuota) || 0,
    enabled: draft.enabled,
    secret: draft.secret,
  }
}

export interface AdminMailProps {
  csrf: string
  data: AdminMailData
}

/**
 * 发信配置：账号卡片墙（每个 key 一张卡）。
 *
 * 版式选卡片而不是表格：多 key 的运维问题只有一个 —— 「哪个号现在还能用」。
 * 卡片把额度进度条、健康灯、冷却倒计时放在一屏里，表格要横向扫才看得出来。
 */
export function AdminMail({ csrf, data }: AdminMailProps) {
  const [settings, setSettings] = useState<MailSettings>(data.settings)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(data.providers[0]?.value ?? 'resend'))

  /**
   * 所有卡片数据都来自服务端渲染，改完直接重载 —— 比在客户端镜像一份状态更不容易不同步。
   * 失败不重载：错误要留在屏幕上给人看。
   */
  async function run(action: () => Promise<string>) {
    setBusy(true)
    setError('')
    try {
      await action()
      window.location.reload()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }

  const providerLabel = (value: string) =>
    data.providers.find((p) => p.value === value)?.label ?? value
  const secretLabel = (value: string) =>
    data.providers.find((p) => p.value === value)?.secretLabel ?? '密钥'
  const secretHint = (value: string) =>
    data.providers.find((p) => p.value === value)?.secretHint ?? ''

  function fields() {
    return (
      <div className="mail-form">
        <Field label="服务商">
          <SelectBox
            value={draft.provider}
            onChange={(provider) => setDraft({ ...draft, provider })}
            options={data.providers.map((p) => ({ value: p.value, label: p.label }))}
            aria-label="服务商"
          />
        </Field>
        <Field label="名称" hint="只给你自己看，例如「主号」「备用号」">
          <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} maxLength={40} />
        </Field>
        <Field label="优先级" hint="数字小的先用；用完了自动落到下一个">
          <Input
            type="number"
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
          />
        </Field>
        <Field label="发件地址">
          <Input
            type="email"
            value={draft.fromAddress}
            onChange={(e) => setDraft({ ...draft, fromAddress: e.target.value })}
            placeholder="noreply@yourdomain.com"
          />
        </Field>
        <Field label="发件人显示名" hint="留空则只显示地址">
          <Input value={draft.fromName} onChange={(e) => setDraft({ ...draft, fromName: e.target.value })} maxLength={60} />
        </Field>
        <Field label="回信地址" hint="留空则用户回复发到发件地址">
          <Input value={draft.replyTo} onChange={(e) => setDraft({ ...draft, replyTo: e.target.value })} />
        </Field>
        <Field label="每日额度" hint="0 = 不限。Resend 免费额度是每个 key 每天 100 封，用完后自动换下一个号">
          <Input
            type="number"
            value={draft.dailyQuota}
            onChange={(e) => setDraft({ ...draft, dailyQuota: e.target.value })}
          />
        </Field>
        <Field label="API 基址" hint="留空即官方 api.resend.com；自建反代或本地测试桩才需要填">
          <Input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.resend.com" />
        </Field>
        <Field label={secretLabel(draft.provider)} hint={secretHint(draft.provider) + (editing === null ? '' : '；留空表示不修改')}>
          <Input
            type="password"
            value={draft.secret}
            onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
            autoComplete="new-password"
            placeholder={editing === null ? 're_…' : '留空 = 不改'}
          />
        </Field>
        <label className="ui-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          <span>启用这个账号</span>
        </label>
      </div>
    )
  }

  return (
    <>
      <section className="mail-global">
        <h3>全局开关</h3>
        <div className="mail-global-row">
          <label className="ui-check">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
            />
            <span>启用邮件发送</span>
          </label>
          <Field label="单邮箱每分钟上限">
            <Input
              type="number"
              value={String(settings.perMinute)}
              onChange={(e) => setSettings({ ...settings, perMinute: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label="重发最小间隔（秒）">
            <Input
              type="number"
              value={String(settings.cooldownSeconds)}
              onChange={(e) => setSettings({ ...settings, cooldownSeconds: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label="验证码有效期（秒）">
            <Input
              type="number"
              value={String(settings.codeTtlSeconds)}
              onChange={(e) => setSettings({ ...settings, codeTtlSeconds: Number(e.target.value) || 0 })}
            />
          </Field>
          <Button size="sm" loading={busy} onClick={() => void run(() => saveMailSettings(csrf, settings))}>
            保存开关
          </Button>
        </div>
        <p className="hint">
          关着的时候不会发任何邮件（默认关）。限流是两层：单个邮箱按上面的间隔与每分钟上限，
          全站另有每分钟 60 封的硬上限，防止有人换邮箱刷。
        </p>
      </section>

      <div className="mail-head">
        <h3>发信账号 <span className="count">{data.accounts.length}</span></h3>
        <Button
          size="sm"
          variant={creating ? 'ghost' : 'primary'}
          onClick={() => {
            setCreating(!creating)
            setEditing(null)
            setDraft(emptyDraft(data.providers[0]?.value ?? 'resend'))
          }}
        >
          {creating ? '取消' : '添加账号'}
        </Button>
      </div>

      {creating && (
        <article className="mail-card" data-tone="new">
          <h4>新账号</h4>
          {fields()}
          <div className="mail-actions">
            <Button size="sm" loading={busy} onClick={() => void run(() => createMailAccount(csrf, toInput(draft)))}>
              保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
          </div>
        </article>
      )}

      {data.accounts.length === 0 && !creating && (
        <p className="empty">还没有发信账号。点「添加账号」填一个 Resend 的 API Key 就能开始。</p>
      )}

      <div className="mail-grid">
        {data.accounts.map((account) => {
          const status = statusOf(account, data.now)
          const unlimited = account.dailyQuota <= 0
          const used = account.quotaDay === 0 ? 0 : account.sentToday
          const percent = unlimited ? 0 : Math.min(100, Math.round((used / account.dailyQuota) * 100))
          const open = editing === account.id
          return (
            <article className="mail-card" key={account.id} data-tone={status.tone}>
              <header>
                <span className="mail-badge">{providerLabel(account.provider)}</span>
                <strong>{account.label || '（未命名）'}</strong>
                <span className="mail-chip" data-tone={status.tone}>{status.label}</span>
                <span className="mail-priority">优先级 {account.priority}</span>
              </header>

              <dl className="mail-meta">
                <div>
                  <dt>发件人</dt>
                  <dd>
                    {account.fromName ? account.fromName + ' ' : ''}
                    {'<' + account.fromAddress + '>'}
                  </dd>
                </div>
                <div>
                  <dt>回信地址</dt>
                  <dd>{account.replyTo || '同发件人'}</dd>
                </div>
                <div>
                  <dt>基址</dt>
                  <dd>{String(account.options.base_url ?? '') || 'api.resend.com'}</dd>
                </div>
                <div>
                  <dt>密钥</dt>
                  <dd>{account.secretSet ? '已配置' : '未配置'}</dd>
                </div>
                <div>
                  <dt>今日用量</dt>
                  <dd>{unlimited ? used + ' 封（不限）' : used + ' / ' + account.dailyQuota + ' 封'}</dd>
                </div>
                <div>
                  <dt>上次成功</dt>
                  <dd>{relative(data.now, account.lastOkAt)}</dd>
                </div>
              </dl>

              {!unlimited && (
                <div className="mail-bar" role="img" aria-label={'今日额度已用 ' + percent + '%'}>
                  <span style={{ width: percent + '%' }} data-full={percent >= 100 ? '1' : '0'} />
                </div>
              )}

              {account.lastError && (
                <p className="mail-error" role="status">
                  最近错误（{relative(data.now, account.lastErrorAt)}）：{account.lastError}
                </p>
              )}

              {open ? (
                <>
                  {fields()}
                  <div className="mail-actions">
                    <Button
                      size="sm"
                      loading={busy}
                      onClick={() => void run(() => updateMailAccount(csrf, account.id, toInput(draft)))}
                    >
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mail-actions">
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => {
                        setEditing(account.id)
                        setCreating(false)
                        setDraft(draftOf(account))
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void run(() => setMailAccountEnabled(csrf, account.id, !account.enabled))
                      }
                    >
                      {account.enabled ? '停用' : '启用'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void run(() => archiveMailAccount(csrf, account.id, !account.archived))}
                    >
                      {account.archived ? '恢复' : '归档'}
                    </Button>
                  </div>
                  <TestBox csrf={csrf} id={account.id} />
                </>
              )}
            </article>
          )
        })}
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

/** 测试发信：真发一封，结果就地显示（成功与否都不重载，方便看回执）。 */
function TestBox({ csrf, id }: { csrf: string; id: number }) {
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [failed, setFailed] = useState(false)

  async function send() {
    setBusy(true)
    setResult('')
    setFailed(false)
    try {
      setResult(await testMailAccount(csrf, id, to))
    } catch (e) {
      setFailed(true)
      setResult(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mail-test">
      <Input
        type="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="收件邮箱"
        aria-label="测试收件邮箱"
      />
      <Button size="sm" variant="subtle" loading={busy} onClick={() => void send()}>
        测试发信
      </Button>
      {result && (
        <span className={failed ? 'mail-test-fail' : 'mail-test-ok'} role="status">
          {result}
        </span>
      )}
    </div>
  )
}
