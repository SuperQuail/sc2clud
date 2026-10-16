import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Flag } from 'lucide-react';
import type { ReportReason } from '@/lib/api/forum';
import { appPath } from '@/lib/url';
// 事由表只有一份真源（后端 binding 的 oneof 与这份文案在 report-panel.tsx 里互相钉着）：
// 这里再写第二份，改一边就会漂移。
import { REASON_LABEL } from '@/routes/_parts/report-panel';

const REASONS = Object.keys(REASON_LABEL) as ReportReason[];

// 「举报 Issue」入口：一颗**行内**按钮（位置由调用方放）+ 收事由的小面板。
// 为什么不用 ReportPanel 整件：那是**内嵌一整片**的版面（个人主页那种页内区域），一行列表里塞不下；
// 但事由的值域与文案只有一份真源 —— 所以这里只复用它，提交仍然走同一个 createReport。
// target_type 固定为 issue（契约 2026-10-16），target_id 是 issue 的 public_id（不是卡片上的 #编号）。
export function IssueReportButton({
  targetLabel,
  onSubmit,
  onDone,
  testId,
}: {
  targetLabel: string;
  /** 提交：product 页给 createReport（真请求），房间页给一个即成的本地 Promise（不发请求）。 */
  onSubmit: (reason: ReportReason, detail: string) => Promise<unknown>;
  /** 关窗时的回执交给宿主显示（宿主才知道回执该放哪儿） */
  onDone?: (label: string) => void;
  testId: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [state, setState] = useState<'idle' | 'done' | 'pending'>('idle');
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setReason(null);
    setDetail('');
    setState('idle');
    setError(null);
    onDone?.(targetLabel);
  }

  if (!open) {
    // 行内入口：与「收起详情」那种 Ring Button 不同，它要能塞进一行文字里（inline），
    // 所以用 role=button 的 span 而不是 Button —— Button 即使 inline 也带 24px 的盒高，会把行撑开。
    // 键盘可达：Enter / Space 与真按钮一致。
    return (
      <span
        role='button'
        tabIndex={0}
        data-testid={testId}
        aria-label={'举报 ' + targetLabel}
        className='inline-flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-[12px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Flag aria-hidden className='size-3.5' />
        举报
      </span>
    );
  }

  if (state === 'done') {
    return (
      <section role='status' data-testid={testId + '-done'} className='flex flex-col gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-[12px] text-foreground'>
        <span>已收到你的举报（{targetLabel}）。管理员会在「举报处理」队列里看到它。</span>
        <span className='flex flex-wrap items-center gap-2'>
          <Button inline={false} height={ControlsHeight.S} href={appPath('me?tab=reports')}>看我的举报</Button>
          <Button inline={false} height={ControlsHeight.S} onClick={close}>知道了</Button>
        </span>
      </section>
    );
  }

  function submit() {
    if (reason === null || state === 'pending') return;
    setState('pending');
    onSubmit(reason, detail.trim())
      .then(() => setState('done'))
      .catch(() => { setState('idle'); setError('提交失败，请重试'); });
  }

  return (
    <section
      data-testid={testId + '-panel'}
      aria-label={'举报 ' + targetLabel}
      className='flex w-full flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3'
      onClick={(e) => e.stopPropagation()}
    >
      <span className='text-[13px] font-medium text-foreground'>举报{targetLabel}</span>
      <span className='text-[11px] text-muted-foreground'>选一个事由（管理员按事由分类处理）：</span>
      <span className='flex flex-wrap items-center gap-1.5'>
        {REASONS.map((r) => (
          <Button
            key={r}
            data-testid={'report-reason-' + r}
            inline={false}
            height={ControlsHeight.S}
            active={reason === r}
            onClick={() => setReason(r)}
          >
            {REASON_LABEL[r]}
          </Button>
        ))}
      </span>
      <Input
        data-testid='report-detail'
        multiline
        rows={2}
        maxLength={1000}
        placeholder='补充说明（可选，最多 1000 字）'
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />
      {error ? <span role='alert' className='text-[12px] text-destructive'>{error}</span> : null}
      <span className='flex flex-wrap items-center gap-2'>
        <Button
          data-testid='report-submit'
          primary
          inline={false}
          height={ControlsHeight.S}
          disabled={reason === null || state === 'pending'}
          onClick={submit}
        >
          {reason === null ? '先选一个事由' : state === 'pending' ? '提交中…' : '提交举报'}
        </Button>
        <Button inline={false} height={ControlsHeight.S} onClick={close}>取消</Button>
      </span>
    </section>
  );
}
