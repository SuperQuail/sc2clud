import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { qk } from '@/lib/query/keys';
import { formatCents, formatTime } from '@/lib/format';
import { DONATION_STATE, fetchMyDonations, withdrawDonation } from '@/lib/api/rewards';

// 「我的打赏记录」——从 payment-channels.tsx 拆出来（D22 把那一块改成 prop 驱动的 View：
// 弹层里只要收款码本身，记录这一节没有落点，所以它自己留一个宿主）。
// 端点：GET /me/rewards（我发出的全部申报，不过滤 state）、DELETE /rewards/{id}（只能撤 pending）。
export function DonationRecordsPanel() {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: qk.myDonations(), queryFn: ({ signal }) => fetchMyDonations({}, signal) });
  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawDonation(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.myDonations() }),
  });

  // Array.isArray：响应形状不对时**这一屏会整页崩**（`rows.map is not a function`，
  // 2026-10-14 settings.test 抓到的），所以列表这一层自己兜住，不指望调用点都记得判。
  const rows = Array.isArray(mine.data?.items) ? mine.data.items : [];

  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
      <h2 className='m-0 text-[15px] font-semibold text-foreground'>我的打赏记录</h2>
      {mine.isPending ? (
        <span className='text-[12px] text-muted-foreground'>正在读记录…</span>
      ) : mine.isError ? (
        <span role='alert' className='text-[12px] text-destructive'>打赏记录读取失败</span>
      ) : rows.length === 0 ? (
        <span className='text-[12px] text-muted-foreground'>还没有申报过打赏。给别人打赏后在对方主页上点「我已完成打赏」就会出现在这里。</span>
      ) : (
        <ul className='flex flex-col gap-2'>
          {rows.map((d) => (
            <li key={d.id} className='flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12px]'>
              <span className='text-foreground'>给 {d.recipient.nickname}</span>
              <span className='tabular-nums text-foreground'>¥{formatCents(d.amount_cents)}</span>
              <span className='text-muted-foreground'>{DONATION_STATE[d.state] ?? d.state}</span>
              <span className='text-muted-foreground'>{formatTime(d.created_at)}</span>
              {/* 只有还没核验的能撤（后端只动 pending；已核验的给 403，所以这里不给入口） */}
              {d.state === 'pending' ? (
                <Button
                  data-testid={'donation-withdraw-' + d.id}
                  inline={false}
                  height={ControlsHeight.S}
                  loader={withdraw.isPending && withdraw.variables === d.id}
                  onClick={() => withdraw.mutate(d.id)}
                >
                  撤回
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {withdraw.isError ? <span role='alert' className='text-[12px] text-destructive'>撤回失败，请重试</span> : null}
    </section>
  );
}
