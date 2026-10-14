import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { Trash2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { ImageUploader, type UploadedImage } from '@/ui/rich/image-uploader';
import { qk } from '@/lib/query/keys';
import { formatCents, formatTime } from '@/lib/format';
import { isApiError } from '@/lib/api/errors';
import {
  addPaymentChannel,
  channelImageSrc,
  deletePaymentChannel,
  DONATION_STATE,
  fetchDonationSettings,
  fetchMyDonations,
  fetchMyChannels,
  updateDonationSettings,
  withdrawDonation,
} from '@/lib/api/rewards';

// 「赞赏与收款码」（本人侧）。2026-10-14 之前这一整块在前端**零接线**：
// 后端 13 条端点早就齐了（收款码在 media 域、展示与申报在 reward 域），库里连一个客户端都没有，
// 所以个人设置页上「收款码」只留了一句「本轮不排」的注释，个人主页上的赞助卡是置灰的。
//
// 端点与字段名逐字照抄（不照 DevRoom 的 mock —— mock 里的 `qr_url` / 顶格 `notice` 后端都不存在）：
//   · POST/GET/DELETE /me/payment-channels（`media/handler.go:43-45`，上传是 multipart 字段 `file` + `label`）
//     —— **本人的码用这一条**，不用 reward 域那条 /users/{handle}/channels（它要过作者的展示开关）
//   · GET/PATCH /me/donation-settings（`reward/handler.go:41-42`，四个字段的部分更新）
//   · GET /me/rewards、DELETE /rewards/{id}（`reward/handler.go:40,45`）
//
// 每用户上限 5 张、单图 512KB 都是**服务端**的硬约束（`media/service.go:39` 与 config.Image.PaymentMax），
// 这里只是把同一批数字显示出来 —— 前端自己再定一套会让「还能传几张」与后端不一致。

/** 收款码是给人扫的：压缩到长边 256（头像位那一档）会糊掉码点，所以用配图位的 1600 与 512KB 目标。 */
const CHANNEL_MAX = 5;
/** 后端的 request body 上限，前端只能更小不能更大（超了是 413，用户看不出为什么）。 */
const CHANNEL_BYTES = 512 * 1024;

export function PaymentChannelsPanel() {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [picked, setPicked] = useState<UploadedImage[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 本人管理自己的码走 /me/payment-channels（不是 /users/{handle}/channels：那条要过作者的展示开关）
  const channels = useQuery({ queryKey: qk.paymentChannels(), queryFn: ({ signal }) => fetchMyChannels(signal) });
  const settings = useQuery({ queryKey: qk.donationSettings(), queryFn: ({ signal }) => fetchDonationSettings(signal) });
  const mine = useQuery({ queryKey: qk.myDonations(), queryFn: ({ signal }) => fetchMyDonations({}, signal) });

  // 上传成功后**清掉 picked**：预览换回服务端那张 /img/<hash>，别停在「本地已选」的假象上。
  const add = useMutation({
    mutationFn: (v: { file: Blob; label: string }) => addPaymentChannel(v.file, v.label),
    onSuccess: () => {
      setPicked([]);
      setLabel('');
      setError(null);
      void qc.invalidateQueries({ queryKey: qk.paymentChannels() });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePaymentChannel(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.paymentChannels() }),
  });
  // 部分更新：只发改过的那个键（后端是 *bool，多发一个键就是覆盖别人那一项）
  const saveSettings = useMutation({
    mutationFn: (patch: { show_channels?: boolean; records_public?: boolean }) => updateDonationSettings(patch),
    onSuccess: (saved) => qc.setQueryData(qk.donationSettings(), saved),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawDonation(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.myDonations() }),
  });

  const list = channels.data ?? [];
  const full = list.length >= CHANNEL_MAX;
  // Array.isArray：响应形状不对时**这一屏会整页崩**（`rows.map is not a function`，
  // 2026-10-14 settings.test 抓到的），所以列表这一层自己兜住，不指望调用点都记得判。
  const rows = Array.isArray(mine.data?.items) ? mine.data.items : [];

  return (
    <section id='payment-channels' className='flex scroll-mt-20 flex-col gap-3 rounded-lg border border-border bg-card p-4'>
      <h2 className='m-0 text-[15px] font-semibold text-foreground'>赞赏与收款码</h2>
      <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
        站点不经手资金：这里只展示你挂的收款码，别人扫码付款后自己来登记一笔申报，你或管理员核对到账后才计入统计。
      </p>

      {channels.isPending ? (
        <span className='text-[12px] text-muted-foreground'>正在读收款码…</span>
      ) : channels.isError ? (
        <span role='alert' className='text-[12px] text-destructive'>
          {isApiError(channels.error) ? channels.error.message : '收款码读取失败'}
        </span>
      ) : (
        <>
          {list.length > 0 ? (
            <ul className='flex flex-wrap gap-3'>
              {list.map((c) => (
                <li key={c.id} className='flex w-[136px] flex-col gap-1.5 rounded-md border border-border p-2'>
                  <img
                    src={channelImageSrc(c)}
                    alt={c.label + '收款码'}
                    width={120}
                    height={120}
                    className='size-32 rounded-sm bg-white object-contain'
                  />
                  <span className='truncate text-[12px] text-foreground'>{c.label}</span>
                  <Button
                    data-testid={'channel-delete-' + c.id}
                    inline={false}
                    height={ControlsHeight.S}
                    danger
                    icon={icon16(Trash2)}
                    loader={remove.isPending && remove.variables === c.id}
                    onClick={() => remove.mutate(c.id)}
                  >
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <span className='text-[12px] text-muted-foreground'>还没有收款码；最多 {CHANNEL_MAX} 张，挂上后别人主页才有打赏入口。</span>
          )}

          <div className='flex flex-col gap-2 border-t border-border pt-3'>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={32}
              label='渠道名'
              placeholder='微信 / 支付宝 / 爱发电'
              help='最多 32 字；留空就用「收款码」。这个名字只用来区分多张码。'
            />
            <ImageUploader
              variant='avatar'
              label='选择收款码图片'
              images={picked}
              onChange={(next) => {
                setPicked(next);
                const f = next[0];
                if (f) add.mutate({ file: f.file, label });
              }}
              maxSize={CHANNEL_BYTES}
              onError={setError}
            />
            {/* 已满时说清为什么点不动，而不是让按钮静默无效 */}
            {full ? (
              <span className='text-[12px] text-muted-foreground'>已经有 {CHANNEL_MAX} 张了，删一张才能再传。</span>
            ) : null}
            {error ? <span role='alert' className='text-[12px] text-destructive'>{error}</span> : null}
            {add.isError ? (
              <span role='alert' className='text-[12px] text-destructive'>
                {isApiError(add.error) ? add.error.message : '上传失败'}
              </span>
            ) : null}
            {remove.isError ? <span role='alert' className='text-[12px] text-destructive'>删除失败，请重试</span> : null}
          </div>

          <div className='flex flex-col gap-2 border-t border-border pt-3'>
            <span className='text-[12px] font-medium text-foreground'>收款码可见性</span>
            {settings.isPending ? (
              <span className='text-[12px] text-muted-foreground'>正在读设置…</span>
            ) : settings.isError ? (
              <span role='alert' className='text-[12px] text-destructive'>赞赏设置读取失败</span>
            ) : (
              <>
                <Toggle
                  checked={settings.data.show_channels}
                  onChange={(e) => saveSettings.mutate({ show_channels: e.target.checked })}
                >
                  在个人主页与帖子右栏展示我的收款码
                </Toggle>
                <Toggle
                  checked={settings.data.records_public}
                  onChange={(e) => saveSettings.mutate({ records_public: e.target.checked })}
                >
                  公开我给出的打赏记录（只影响我作为打赏人那一侧；逐行判，对方关了也看不到）
                </Toggle>
                {saveSettings.isError ? (
                  <span role='alert' className='text-[12px] text-destructive'>
                    {isApiError(saveSettings.error) ? saveSettings.error.message : '保存失败'}
                  </span>
                ) : null}
              </>
            )}
          </div>
        </>
      )}

      <div className='flex flex-col gap-2 border-t border-border pt-3'>
        <span className='text-[12px] font-medium text-foreground'>我的打赏记录</span>
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
      </div>
    </section>
  );
}
