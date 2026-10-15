import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Eye, Save, Undo2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { MailTemplate, MailTemplatePreview } from '@/lib/api/admin';
import { ConfirmDialog } from '../confirm';
import { GateNote, Panel, Pill, ScreenHead } from '../bits';

const KIND_LABELS: Record<string, string> = {
  verify_email: '邮箱验证码',
  reset_password: '重置密码验证码',
  test: '发信测试',
  notice: '站内通知',
};

// 15-.mailtpl 邮件模板（D37）。**prop 驱动**：取数与请求在 routes/admin/mail-tpl.tsx 的容器里，
// 屏里不发请求、不认路由（§0 同源方法）。四行固定 kind：custom 标记「用的是内置还是自定义」
//（缺行回落 embed —— custom=false 时那三份源就是内置的，编辑框填现状，不是空框）。
// 编辑器就是等宽文本域（Ring Input multiline），不做富文本：内嵌邮件框架是系统已有能力。
// 预览是**转义后的真渲染**：样本昵称带 <script>；HTML 进 sandbox iframe、纯文本并列 <pre>。
export type MailTemplateScreenProps = {
  templates: MailTemplate[];
  loading?: boolean;
  error?: ReactNode;
  canManage: boolean;
  /** 编辑框三份源全量发送（PUT 语义） */
  onSave: (kind: string, body: { subject: string; html_body: string; text_body: string }) => void;
  /** 恢复内置 = DELETE（下一次渲染落回 embed） */
  onReset: (kind: string) => void;
  /** 预览：三段可选 —— 就送编辑框里还没保存的那份 */
  onPreview: (kind: string, body: { subject?: string; html_body?: string; text_body?: string }) => void;
  preview: MailTemplatePreview | null;
  previewBusy?: boolean;
  busy?: boolean;
  /** 保存被拒的字段级错误（后端 error.fields：编译错误原话带行位，就地显示） */
  fields?: Record<string, string> | null;
  receipt?: ReactNode;
};

export function MailTemplateScreen({
  templates,
  loading = false,
  error = null,
  canManage,
  onSave,
  onReset,
  onPreview,
  preview,
  previewBusy = false,
  busy = false,
  fields = null,
  receipt,
}: MailTemplateScreenProps) {
  const [activeKind, setActiveKind] = useState<string | null>(templates[0]?.kind ?? null);
  const [confirmReset, setConfirmReset] = useState<MailTemplate | null>(null);
  const active = templates.find((t) => t.kind === activeKind) ?? templates[0] ?? null;
  const customs = templates.filter((t) => t.custom).length;

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='邮件模板'
        note='四封信的真源：verify_email / reset_password / test / notice；缺行 = 内置模板，下面就是当前生效的那几段。'
      />
      <p className='max-w-[860px] text-[12px] leading-relaxed text-muted-foreground'>
        D37：主题 / HTML 正文 / 纯文本替身三段**模板源**可自定义（Go text/template 与 html/template 语法；变量见文末表）。
        保存时后端按双模板编译校验，语法错 / 尾块错**当场拒收**（400，错误原话带行位就地显示）；
        预览是**转义后的真渲染**：样本昵称带 <code>&lt;script&gt;</code>，HTML 进沙盒 iframe，纯文本并列。
      </p>
      <div className='flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground'>
        <Pill tone={customs > 0 ? 'ok' : 'outline'}>{customs} 份已自定义</Pill>
        <span data-testid='mail-tpl-summary'>
          {templates.length} 个模板 · 保存后立即生效（单实例，下一次投递就用新版）
        </span>
      </div>
      {!canManage ? <GateNote perm='site.setting'>整屏只读：本账号没有 site.setting。</GateNote> : null}
      {receipt}
      {error}

      <div className='grid items-start gap-3 lg:grid-cols-[248px_minmax(0,1fr)]'>
        <Panel title='模板' data-testid='mail-tpl-list'>
          <div className='flex flex-col gap-1.5'>
            {loading ? <p className='text-[12px] text-muted-foreground'>加载中…</p> : null}
            {templates.map((t) => (
              <Button
                key={t.kind}
                data-testid={'mail-tpl-kind-' + t.kind}
                inline={false}
                height={ControlsHeight.S}
                active={t.kind === active?.kind}
                onClick={() => setActiveKind(t.kind)}
              >
                <span className='flex w-full items-center justify-between gap-2'>
                  <span>{KIND_LABELS[t.kind] ?? t.kind}</span>
                  <Pill tone={t.custom ? 'ok' : 'outline'}>{t.custom ? '自定义' : '内置'}</Pill>
                </span>
              </Button>
            ))}
          </div>
        </Panel>

        {active ? (
          <TemplateEditor
            key={active.kind + String(active.updated_at ?? '')}
            tpl={active}
            canManage={canManage}
            busy={busy}
            previewBusy={previewBusy}
            fields={fields}
            onSave={onSave}
            onPreview={onPreview}
            onAskReset={() => setConfirmReset(active)}
          />
        ) : null}
      </div>

      {preview ? (
        <Panel
          title='预览（渲染后）'
          note='样本数据：站名取站点设置，昵称故意带 <script>。HTML 在沙盒 iframe（不执行任何脚本、不加载外链），纯文本并列保留原文。'
          data-testid='mail-tpl-preview-panel'
        >
          <p className='mb-2 text-[12px] font-medium text-foreground' data-testid='mail-tpl-preview-subject'>
            主题：{preview.subject}
          </p>
          <iframe
            data-testid='mail-tpl-frame'
            title='邮件预览（沙盒）'
            sandbox=''
            srcDoc={preview.html}
            className='h-[420px] w-full rounded-md border border-border bg-white'
          />
          <pre
            data-testid='mail-tpl-text'
            className='mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-2 font-mono text-[12px] text-foreground'
          >
            {preview.text}
          </pre>
        </Panel>
      ) : null}

      <Panel title='模板能用的变量（platform/mail 的 Data）' note='自定义只覆盖三段源，HTML 骨架 layout 恒为内置 —— 骨架里那两处转义语义不变。'>
        <div className='flex flex-wrap gap-1.5'>
          {['{{.SiteName}}', '{{.Nickname}}', '{{.Code}}', '{{.ExpiresIn}}', '{{.Title}}', '{{.Body}}', '{{.Link}}', '{{.From}}', '{{.Now}}'].map((v) => (
            <code key={v} className='rounded-sm bg-muted px-1 font-mono text-[11px] text-foreground'>{v}</code>
          ))}
        </div>
      </Panel>

      <ConfirmDialog
        show={confirmReset !== null}
        label='恢复内置模板？'
        danger
        confirmText='恢复内置'
        body={
          <span>
            删除 <b>{confirmReset ? KIND_LABELS[confirmReset.kind] ?? confirmReset.kind : ''}</b>
            {' '}的自定义版本：下一次渲染立即落回系统内置模板（存档的源码随之删除）。
          </span>
        }
        onClose={() => setConfirmReset(null)}
        onConfirm={() => { if (confirmReset) onReset(confirmReset.kind); setConfirmReset(null); }}
      />
    </div>
  );
}

/** 单模板编辑器（keyed remount：切模板时重置为该模板的现状）。 */
function TemplateEditor({ tpl, canManage, busy, previewBusy, fields, onSave, onPreview, onAskReset }: {
  tpl: MailTemplate;
  canManage: boolean;
  busy: boolean;
  previewBusy: boolean;
  fields: Record<string, string> | null;
  onSave: MailTemplateScreenProps['onSave'];
  onPreview: MailTemplateScreenProps['onPreview'];
  onAskReset: () => void;
}) {
  const [subject, setSubject] = useState(tpl.subject);
  const [htmlBody, setHtmlBody] = useState(tpl.html_body);
  const [textBody, setTextBody] = useState(tpl.text_body);
  const dirty = subject !== tpl.subject || htmlBody !== tpl.html_body || textBody !== tpl.text_body;

  return (
    <Panel
      title={(KIND_LABELS[tpl.kind] ?? tpl.kind) + (tpl.custom ? '（自定义）' : '（内置）')}
      note={tpl.updated_at ? '上次改动 ' + tpl.updated_at.slice(0, 16).replace('T', ' ') : '从未改过：正在用内置模板'}
      data-testid={'mail-tpl-editor-' + tpl.kind}
    >
      <div className='flex flex-col gap-2'>
        <div data-testid='mail-tpl-edit-subject'>
          <Input label='主题（text/template，可插值比如 {{.Code}}）' value={subject} disabled={!canManage || busy} size={Size.FULL} onChange={(e) => setSubject(e.target.value)} />
          <FieldErr testid='mail-tpl-err-subject' text={fields?.subject ?? ''} />
        </div>
        <div data-testid='mail-tpl-edit-html'>
          <Input label='HTML 正文（html/template：双花括号插值，用户输入按上下文转义）' multiline rows={10} value={htmlBody} disabled={!canManage || busy} size={Size.FULL} inputClassName='font-mono !h-[240px]' onChange={(e) => setHtmlBody(e.target.value)} />
          <FieldErr testid='mail-tpl-err-html_body' text={fields?.html_body ?? ''} />
        </div>
        <div data-testid='mail-tpl-edit-text'>
          <Input label='纯文本替身（text/template：不转义，原样进纯文本正文）' multiline rows={6} value={textBody} disabled={!canManage || busy} size={Size.FULL} inputClassName='font-mono !h-[150px]' onChange={(e) => setTextBody(e.target.value)} />
          <FieldErr testid='mail-tpl-err-text_body' text={fields?.text_body ?? ''} />
        </div>
      </div>
      <div className='mt-3 flex justify-end gap-2'>
        <Button data-testid='mail-tpl-reset' inline={false} height={ControlsHeight.S} icon={icon16(Undo2)} onClick={onAskReset}>恢复内置</Button>
        <Button
          data-testid='mail-tpl-preview'
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(Eye)}
          disabled={previewBusy}
          onClick={() => onPreview(tpl.kind, { subject, html_body: htmlBody, text_body: textBody })}
        >
          预览（渲染后）
        </Button>
        <Button
          data-testid='mail-tpl-save'
          primary
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(Save)}
          disabled={!canManage || busy || !dirty}
          onClick={() => onSave(tpl.kind, { subject, html_body: htmlBody, text_body: textBody })}
        >
          保存改动
        </Button>
      </div>
    </Panel>
  );
}

function FieldErr({ testid, text }: { testid: string; text: string }) {
  if (!text) return null;
  return <p role='alert' data-testid={testid} className='mt-0.5 text-[11px] leading-relaxed text-destructive'>{text}</p>;
}
