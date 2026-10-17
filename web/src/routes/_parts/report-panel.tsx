import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { useMutation } from '@tanstack/react-query';
import { createReport, type ReportReason, type ReportTargetType } from '@/lib/api/forum';
import { isApiError } from '@/lib/api/errors';

// 举报面板。**盲测发现：接口一直在、前端连函数都没有**，于是「看到违规内容没法举报」。
//
// 事由的值域**只**声明在后端 `CreateReportInput` 的 binding tag 里（`oneof=spam abuse illegal offtopic other`）——
// report 域有契约测试盯着它，所以这里的五条必须与它逐字一致：改一边就得改另一边。
/** 给「我的举报」复用：事由的展示文案只有这一份（否则两处各写一套，改一边就漂移）。 */
export const REASON_LABEL: Record<ReportReason, string> = {
  spam: '垃圾广告',
  abuse: '人身攻击',
  illegal: '侵权',
  offtopic: '与分区内容无关（跑题）',
  other: '其它',
};

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: REASON_LABEL.spam },
  { value: 'abuse', label: REASON_LABEL.abuse },
  { value: 'illegal', label: REASON_LABEL.illegal },
  { value: 'offtopic', label: REASON_LABEL.offtopic },
  { value: 'other', label: REASON_LABEL.other },
];

export function ReportPanel({
  targetType,
  targetId,
  targetLabel,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: string;
  /** 给人看的对象名（「这篇帖子」/「这条回复」），回执里会带上，免得用户忘了自己举报了什么 */
  targetLabel: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [done, setDone] = useState(false);

  const submit = useMutation({
    mutationFn: () =>
      createReport({
        target_type: targetType,
        target_id: targetId,
        reason: reason as ReportReason,
        detail: detail.trim() === '' ? undefined : detail.trim(),
      }),
    onSuccess: () => setDone(true),
  });

  if (done) {
    return (
      <section role='status' className='flex flex-col gap-2 rounded-lg border border-border bg-muted px-3 py-3 text-[13px]'>
        <span className='font-medium text-foreground'>已收到你的举报（{targetLabel}）。</span>
        <span className='text-muted-foreground'>管理员会在「举报处理」队列里看到它；你可以在「我的举报」里跟进进展。</span>
        <span className='flex gap-2'>
          <Button inline={false} height={ControlsHeight.S} href={'/me?tab=reports'}>
            看我的举报
          </Button>
          <Button inline={false} height={ControlsHeight.S} onClick={onClose}>
            知道了
          </Button>
        </span>
      </section>
    );
  }

  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border bg-muted px-3 py-3'>
      <span className='text-[13px] font-medium text-foreground'>举报{targetLabel}</span>
      <span className='flex flex-wrap items-center gap-2'>
        {REASONS.map((r) => (
          <Button
            key={r.value}
            data-testid={'report-reason-' + r.value}
            inline={false}
            height={ControlsHeight.S}
            active={reason === r.value}
            onClick={() => setReason(r.value)}
          >
            {r.label}
          </Button>
        ))}
      </span>
      <Input
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder='补充说明（可选，最多 1000 字）'
        data-testid='report-detail'
      />
      <span className='flex flex-wrap items-center gap-2'>
        <Button
          data-testid='report-submit'
          primary
          inline={false}
          height={ControlsHeight.S}
          disabled={reason === null || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {reason === null ? '先选一个事由' : '提交举报'}
        </Button>
        <Button inline={false} height={ControlsHeight.S} onClick={onClose}>
          取消
        </Button>
        {submit.isError ? (
          <span role='alert' className='text-[12px] text-destructive'>
            {isApiError(submit.error) ? submit.error.message : '提交失败，请重试'}
          </span>
        ) : null}
      </span>
    </section>
  );
}