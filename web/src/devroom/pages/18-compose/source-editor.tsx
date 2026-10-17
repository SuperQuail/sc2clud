import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { CheckCircle2, Pencil, Plus, Trash2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { formatTime } from '@/lib/format';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import type { SourceInput } from '@/lib/api/forum';
import {
  MAX_SOURCES,
  PROVIDER_SITE,
  emptyForm,
  formOf,
  siteOf,
  sourceBodyOf,
  sourceFieldErrors,
  type SourceForm,
  type SourceRow,
} from './source-form';

// 下载来源编辑器（用户点名的缺失：全站原来只有「看来源」的地方，没有「填来源」的地方）。
//
// 同一份件在两个地方跑：**DevRoom 18-compose**（本地 state，验样子）与真页面 routes/compose.tsx
// （接 POST/PATCH/DELETE /topics/{id}/sources）。所以它是纯 props 的：增删改都由调用方拿去做，
// 自己只管表单、校验（source-form.ts）、以及「点了没反应」的那半 —— 保存成功给一行 role=status。
//
// 之所以能挂在发帖页上：后端按 topic id 挂来源，所以只有**编辑已有的资源帖**时才画得出来。

export function SourceEditor({
  items,
  disabled = false,
  busy = false,
  error = null,
  fieldErrors,
  onSave,
  onDelete,
  onVerify,
}: {
  items: SourceRow[];
  /** 不能写时整块禁用（未激活 / 没有 topic.create）—— 与正文表单同一个闸门 */
  disabled?: boolean;
  busy?: boolean;
  /** 请求失败的原因（父组件的 mutation error），显示在表单上方 */
  error?: string | null;
  /** 后端 400 的 fields（键名就是 JSON 字段名），并到本地校验里逐字段显示 */
  fieldErrors?: Record<string, string>;
  /** id 为空 = 新增；有 id = 改那一条（后端 PATCH 也是整条替换）。reject 时表单不关、内容不丢 */
  onSave: (body: SourceInput, id?: string) => Promise<unknown>;
  onDelete: (row: SourceRow) => Promise<unknown>;
  onVerify?: (row: SourceRow) => Promise<unknown>;
}) {
  const [open, setOpen] = useState<{ id: string | null; form: SourceForm } | null>(null);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const errors: Record<string, string> = { ...localErrors, ...fieldErrors };
  const providerOptions = Object.entries(PROVIDER_SITE).map(([key, v]) => ({ key, label: v.label }));

  function startAdd() {
    setLocalErrors({});
    setConfirmId(null);
    setOpen({ id: null, form: emptyForm() });
  }

  function patch(p: Partial<SourceForm>) {
    setOpen((o) => (o ? { ...o, form: { ...o.form, ...p } } : o));
  }

  async function save() {
    if (!open) return;
    const bad = sourceFieldErrors(open.form);
    if (Object.keys(bad).length > 0) {
      setLocalErrors(bad);
      return;
    }
    setLocalErrors({});
    const who = siteOf(open.form.provider).label + (open.form.label.trim() ? ' · ' + open.form.label.trim() : '');
    try {
      await onSave(sourceBodyOf(open.form), open.id ?? undefined);
      setStatus((open.id ? '已保存修改：' : '已添加：') + who);
      setOpen(null);
    } catch {
      // 失败别关表单：错误由 error / fieldErrors 显示，人不用重打一遍
    }
  }

  async function remove(row: SourceRow) {
    try {
      await onDelete(row);
      setConfirmId(null);
      setStatus('已删除：' + siteOf(row.provider).label);
    } catch {
      // 同上：错误由 error 显示，这一行留在原地
    }
  }

  async function verify(row: SourceRow) {
    if (!onVerify) return;
    try {
      await onVerify(row);
      setStatus('已标记有效：' + siteOf(row.provider).label);
    } catch {
      // 同上
    }
  }

  return (
    <section data-testid='compose-sources' className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h2 className='m-0 text-[13px] font-semibold text-foreground'>
          下载来源
          <span className='ml-2 text-[12px] font-normal text-muted-foreground'>
            {items.length} / {MAX_SOURCES}
          </span>
        </h2>
        {!open && items.length < MAX_SOURCES ? (
          <Button
            data-testid='source-add'
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(Plus)}
            disabled={disabled}
            onClick={startAdd}
          >
            添加来源
          </Button>
        ) : null}
      </div>
      <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
        读者点圆形站点图就走服务端转链端点（302 后计数），前端不暴露直链。老库的 123pan / direct 在新站叫
        pan123 / website。
      </p>

      {error ? <FormAlert tone='error' title='没能保存这条来源' description={error} /> : null}

      {items.length === 0 && !open ? (
        <p
          data-testid='source-empty'
          className='m-0 rounded-lg border border-dashed border-border px-3 py-3 text-[12px] text-muted-foreground'
        >
          还没有下载来源。资源帖没有来源时读者只能看正文：把网盘 / 官网 / 代码仓库的地址填在这里。
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className='m-0 flex list-none flex-col gap-2 p-0'>
          {items.map((row) => (
            <SourceRowItem
              key={row.id}
              row={row}
              disabled={disabled || busy}
              confirming={confirmId === row.id}
              canVerify={onVerify !== undefined}
              onEdit={() => {
                setLocalErrors({});
                setConfirmId(null);
                setOpen({ id: row.id, form: formOf(row) });
              }}
              onDelete={() => void remove(row)}
              onVerify={() => void verify(row)}
              onConfirm={() => setConfirmId(row.id)}
              onCancel={() => setConfirmId(null)}
            />
          ))}
        </ul>
      ) : null}

      {open ? (
        <fieldset
          disabled={disabled || busy}
          className='m-0 flex flex-col gap-3 rounded-md border border-border p-3'
        >
          <legend className='px-1 text-[12px] font-medium text-foreground'>
            {open.id ? '编辑这条来源' : '新增一条来源'}
          </legend>
          <Select
            type={SelectType.INPUT}
            label='站点'
            data={providerOptions}
            selected={providerOptions.find((p) => p.key === open.form.provider) ?? null}
            onSelect={(item) => {
              if (item) patch({ provider: String(item.key) as SourceForm['provider'] });
            }}
          />
          {errors.provider ? (
            <span role='alert' className='text-[11px] text-destructive'>
              {errors.provider}
            </span>
          ) : null}
          <Input
            data-testid='source-url'
            size={Size.FULL}
            label='链接'
            value={open.form.url}
            onChange={(e) => patch({ url: e.target.value })}
            error={errors.url}
            placeholder='https://pan.baidu.com/s/…'
            help='必须是 http(s) 链接；填分享页地址，不是提取页。读者点图标时由服务端 302 过去。'
          />
          <div className='flex flex-wrap gap-3'>
            <Input
              data-testid='source-label'
              label='备注名'
              value={open.form.label}
              onChange={(e) => patch({ label: e.target.value })}
              error={errors.label}
              placeholder='主线战役 v3.1（补丁合集）'
            />
            <Input
              data-testid='source-code'
              label='提取码'
              value={open.form.extraction_code}
              onChange={(e) => patch({ extraction_code: e.target.value })}
              error={errors.extraction_code}
              placeholder='sc2c'
            />
            <Input
              data-testid='source-size'
              label='大小'
              value={open.form.size}
              onChange={(e) => patch({ size: e.target.value })}
              error={errors.size}
              placeholder='2.4 GB'
            />
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              data-testid='source-save'
              primary
              inline={false}
              height={ControlsHeight.S}
              loader={busy}
              disabled={disabled || busy}
              onClick={() => void save()}
            >
              保存
            </Button>
            <Button
              data-testid='source-cancel'
              inline={false}
              height={ControlsHeight.S}
              disabled={busy}
              onClick={() => setOpen(null)}
            >
              取消
            </Button>
            <span className='text-[11px] text-muted-foreground'>保存后立刻对读者生效。</span>
          </div>
        </fieldset>
      ) : null}

      {status ? (
        <p role='status' data-testid='source-status' className='m-0 text-[12px] text-muted-foreground'>
          {status}
        </p>
      ) : null}
    </section>
  );
}

/** 一行来源：站点图 + 名称 + 链接 + 提取码 / 大小 / 最后核对，右边是三个动作。
 *  upkeep=archived 只在这里「看」：后端 sourceBody 没把 upkeep 开进写入体，界面改不了它。
 *  删除要**再点一次**（后端 DELETE 是物理删除，误删就没了）。 */
function SourceRowItem({
  row,
  disabled,
  confirming,
  canVerify,
  onEdit,
  onDelete,
  onVerify,
  onConfirm,
  onCancel,
}: {
  row: SourceRow;
  disabled: boolean;
  confirming: boolean;
  canVerify: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onVerify: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const site = siteOf(row.provider);
  const { Icon } = site;
  return (
    <li
      data-testid={'source-row-' + row.id}
      className='flex flex-wrap items-start gap-3 rounded-md border border-border px-3 py-2'
    >
      <span className='mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground'>
        <Icon aria-hidden className='size-4' />
      </span>
      <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='flex flex-wrap items-baseline gap-x-2 text-[13px] text-foreground'>
          <b className='font-semibold'>{site.label}</b>
          {row.label ? <span className='text-muted-foreground'>{row.label}</span> : null}
          {row.upkeep === 'archived' ? (
            <span className='text-[11px] text-destructive'>已归档（作者不再更新）</span>
          ) : null}
        </span>
        <span className='truncate font-mono text-[11px] text-muted-foreground' title={row.url}>
          {row.url}
        </span>
        <span className='flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground'>
          {row.size ? <span>{row.size}</span> : null}
          {row.extraction_code ? (
            <span>
              提取码 <span className='font-mono text-foreground'>{row.extraction_code}</span>
            </span>
          ) : null}
          <span>{row.verified_at ? '最后核对于 ' + formatTime(row.verified_at) : '还没点过「确认有效」'}</span>
        </span>
      </span>
      {disabled ? null : confirming ? (
        <span className='flex flex-wrap items-center gap-2'>
          <span className='text-[11px] text-destructive'>删除后读者列表里就没有这条了</span>
          <Button
            data-testid={'source-delete-confirm-' + row.id}
            primary
            inline={false}
            height={ControlsHeight.S}
            onClick={onDelete}
          >
            确认删除
          </Button>
          <Button inline={false} height={ControlsHeight.S} onClick={onCancel}>
            取消
          </Button>
        </span>
      ) : (
        <span className='flex flex-wrap items-center gap-2'>
          {canVerify ? (
            <Button
              data-testid={'source-verify-' + row.id}
              inline={false}
              height={ControlsHeight.S}
              icon={icon16(CheckCircle2)}
              title='我确认它还有效（会记下核对时间）'
              onClick={onVerify}
            >
              确认有效
            </Button>
          ) : null}
          <Button
            data-testid={'source-edit-' + row.id}
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(Pencil)}
            onClick={onEdit}
          >
            编辑
          </Button>
          <Button
            data-testid={'source-delete-' + row.id}
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(Trash2)}
            onClick={onConfirm}
          >
            删除
          </Button>
        </span>
      )}
    </li>
  );
}
