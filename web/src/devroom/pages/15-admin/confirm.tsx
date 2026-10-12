import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Tooltip from '@jetbrains/ring-ui-built/components/tooltip/tooltip';
import { AlertTriangle } from 'lucide-react';
import { DisabledReason } from './bits';

// 危险动作的二次确认（封号 / 拒绝 / 删除 / 撤回）。用 Ring UI Dialog：
// 遮罩点击、Esc、焦点陷阱都由控件负责——自己写弹层最容易漏焦点与层级。
// **disabledReason 是必需的**：本项目的规矩是「禁用必须说为什么」，所以灰按钮旁边一定有一句话。
export function ConfirmDialog({
  show,
  label,
  body,
  confirmText,
  danger = false,
  reasonLabel,
  reasonRequired = false,
  disabledReason,
  onConfirm,
  onClose,
}: {
  show: boolean;
  label: string;
  body: ReactNode;
  confirmText: string;
  danger?: boolean;
  /** 需要写备注时传（例如拒绝理由、举报处理备注）；备注会进审计 */
  reasonLabel?: string;
  reasonRequired?: boolean;
  disabledReason?: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  if (!show) return null;
  const blocked = Boolean(disabledReason) || (reasonRequired && reason.trim() === '');
  return (
    <Dialog show label={label} onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[440px] max-w-full flex-col gap-3 p-4'>
        <div className='flex items-start gap-2'>
          <AlertTriangle size={16} aria-hidden className={danger ? 'mt-0.5 text-destructive' : 'mt-0.5 text-primary'} />
          <div className='text-[13px] leading-relaxed text-foreground'>{body}</div>
        </div>
        {reasonLabel ? (
          <Input
            label={reasonLabel}
            multiline
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={reasonRequired && reason.trim() === '' ? '必填：理由会写进审计日志' : undefined}
          />
        ) : null}
        {disabledReason ? <DisabledReason>{disabledReason}</DisabledReason> : null}
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Tooltip title={disabledReason ?? ''} hide={!disabledReason}>
            <Button danger={danger} disabled={blocked} onClick={() => { onConfirm(reason); setReason(''); }}>
              {confirmText}
            </Button>
          </Tooltip>
        </div>
      </div>
    </Dialog>
  );
}

/** 危险动作按钮：禁用时把原因挂在 tooltip 上，并在旁边留一句话。 */
export function DangerAction({ children, onClick, disabled, why }: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** 为什么禁用（禁用时必填） */
  why?: string;
}) {
  return (
    <Tooltip title={why ?? ''} hide={!why}>
      <Button danger disabled={disabled} onClick={onClick}>{children}</Button>
    </Tooltip>
  );
}
