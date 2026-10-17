import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Radio from '@jetbrains/ring-ui-built/components/radio/radio';
import { Flag } from 'lucide-react';
import { icon16 } from '@/ui/icons';
// reason 的**值域**只从接口层那一份取（后端 CreateReportInput 的 binding：oneof=spam abuse illegal offtopic other，
// report 域有契约测试盯着它）。**不从 15-admin 的 mock 类型取** —— 真站会引到这份弹层，
// 它不该因此把房间的假数据模块拖进业务代码（哪怕只是类型）。
import type { ReportReason } from '@/lib/api/forum';

// 「举报」弹层：事由单选（值域照后端 reports.reason）+ 可选补充说明 + 提交/取消。
// 为什么理由必须单选而不是自由文本：管理队列那一列就是按 reason 分类的，
// 自由文本进去，管理员没法筛、也没法统计——举报动作与管理队列之间必须能对上（盲审二号 ③）。
//
// 值域与文案**逐字对齐** 15-admin/mock/content.ts 的 REPORT_REASON（管理队列「理由」列与详情用它）：
//   spam 垃圾广告 / abuse 人身攻击 / illegal 侵权 · 违规内容 / offtopic 与分区内容无关（跑题）/ other 其它
// shortcut: 这份中文映射与管理侧那份是同一张表的两处拷贝（两处都在 devroom 页目录里，
//   提到 src/features/report 是接线时的事）；改文案时**两处一起改**。
export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  spam: '垃圾广告',
  abuse: '人身攻击',
  illegal: '侵权 / 违规内容',
  offtopic: '与分区内容无关（跑题）',
  other: '其它',
};

const REASONS = Object.keys(REPORT_REASON_LABEL) as ReportReason[];

export function ReportDialog({
  targetLabel,
  onSubmit,
  onClose,
}: {
  /** 被举报对象的一句话（帖子标题 / 回复摘要），让人确认自己没点错行 */
  targetLabel: string;
  onSubmit: (reason: ReportReason, detail: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!reason) {
      setError('先选一个事由：管理员按事由分类处理，选「其它」也要能一眼看懂是什么问题');
      return;
    }
    setError(null);
    onSubmit(reason, detail.trim());
  }

  return (
    <Dialog
      show
      modal
      trapFocus
      label='举报'
      showCloseButton
      onCloseAttempt={onClose}
      onOverlayClick={onClose}
      onEscPress={onClose}
      contentClassName='w-full max-w-[520px] p-5'
    >
      <div className='flex flex-col gap-4'>
        <div className='flex flex-col gap-1'>
          <h2 className='flex items-center gap-2 text-base font-semibold text-foreground'>
            <Flag aria-hidden className='size-4 text-destructive' />
            举报
          </h2>
          <p className='text-[12px] leading-relaxed text-muted-foreground'>
            举报对象：<span className='text-foreground'>{targetLabel}</span>
            <br />
            提交后进入「举报处理」队列（待处理），管理员按你选的事由分类处理。
          </p>
        </div>

        <div className='flex flex-col gap-2'>
          <span id='report-reason-label' className='text-[12px] font-medium text-foreground'>
            事由（单选）
          </span>
          <div
            role='radiogroup'
            aria-labelledby='report-reason-label'
            className='flex flex-col gap-2 rounded-md border border-border px-3 py-2.5'
          >
            {/* Radio 自己**不渲染任何 DOM**（它只是 RadioContext.Provider），标签与圆圈都在 Radio.Item 上：
                写成 <Radio>文案</Radio> 的话，页面上只剩一行连在一起的纯文字，一个可点的圆圈都没有。
                Radio 是「这一组」（name + 当前值）；Radio.Item 是「其中一个」（value）。 */}
            {REASONS.map((r) => (
              <Radio.Item
                key={r}
                name='report-reason'
                value={r}
                checked={reason === r}
                onChange={() => {
                  setReason(r);
                  setError(null);
                }}
              >
                {REPORT_REASON_LABEL[r]}
              </Radio.Item>
            ))}
          </div>
        </div>

        <Input
          label='补充说明（选填）'
          multiline
          rows={3}
          maxLength={1000}
          help='写清楚「哪一句、哪一张图、什么时候」——管理员不用回来问你'
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />

        {error ? (
          <p role='alert' className='text-[12px] text-destructive'>
            {error}
          </p>
        ) : null}

        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Button primary danger data-testid='report-submit' icon={icon16(Flag)} onClick={submit}>
            提交举报
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
