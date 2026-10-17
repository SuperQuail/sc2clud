import { useEffect, useRef, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { Trash2 } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { ImageUploader, type UploadedImage } from '@/ui/rich/image-uploader';
import { AVATAR_MAX_BYTES } from '@/ui/rich/image-pipeline';
import { channelImageSrc, type DonationSettings, type PaymentChannel } from '@/lib/api/rewards';
import { CHANNEL_MAX, CHANNEL_TARGET } from './payment-channels-hook';

// 「赞赏与收款码」的本人侧：收款码列表 + 传新码 + 展示开关。
// **只吃 props**（§0 同源）：取数与写动作在 payment-channels-hook.ts，两个宿主各给一份 ——
//   · 个人设置页那一格（PaymentChannelsPanel）；
//   · 个人主页右栏那颗「设置我的收款码」就地弹层（D22，SponsorCard 里）。
// 房间没有 QueryClient，所以它给的是本地 state（选中即结果那一套）。

export type PaymentChannelsViewProps = {
  channels: PaymentChannel[];
  /** 「还能传几张」按它算（服务端的硬上限是 media 域的 maxPaymentChannels）。 */
  limit?: number;
  pending?: boolean;
  error?: string | null;
  settings?: DonationSettings;
  settingsPending?: boolean;
  settingsError?: string | null;
  saveError?: string | null;
  /** 挂到 ImageUploader 上的提示：不由它自己画（D1：同一句话出现过两次） */
  notice?: string | null;
  onNotice?: (message: string) => void;
  /** 选中一张（已按收款码那一档压好）：宿主发 POST /me/payment-channels */
  onAdd: (file: Blob, label: string) => void;
  addPending?: boolean;
  addError?: string | null;
  onDelete: (id: string) => void;
  removePending?: boolean;
  removeError?: string | null;
  onShowChannels?: (on: boolean) => void;
};

export function PaymentChannelsView({
  channels,
  limit = CHANNEL_MAX,
  pending = false,
  error,
  settings,
  settingsPending = false,
  settingsError,
  saveError,
  notice,
  onNotice,
  onAdd,
  addPending = false,
  addError,
  onDelete,
  removePending = false,
  removeError,
  onShowChannels,
}: PaymentChannelsViewProps) {
  const [label, setLabel] = useState('');
  const [picked, setPicked] = useState<UploadedImage[]>([]);
  const full = channels.length >= limit;
  // 上传成功后清掉本地预览：预览该换回服务端那张 /img/<hash>，别停在「本地已选」的假象上
  // （原来那半在宿主的 onSuccess 里，现在宿主只有 props，所以在这里收口）。
  const uploading = useRef(false);
  useEffect(() => {
    if (addPending) uploading.current = true;
    else if (uploading.current) {
      uploading.current = false;
      setPicked([]);
      setLabel('');
    }
  }, [addPending]);

  return (
    <div className='flex flex-col gap-3'>
      {pending ? (
        <span className='text-[12px] text-muted-foreground'>正在读收款码…</span>
      ) : error ? (
        <span role='alert' className='text-[12px] text-destructive'>{error}</span>
      ) : (
        <>
          {channels.length > 0 ? (
            <ul className='flex flex-wrap gap-3'>
              {channels.map((c) => (
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
                    loader={removePending}
                    onClick={() => onDelete(c.id)}
                  >
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <span className='text-[12px] text-muted-foreground'>还没有收款码；最多 {limit} 张，挂上后别人主页才有打赏入口。</span>
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
                if (f) onAdd(f.file, label);
              }}
              maxSize={AVATAR_MAX_BYTES}
              targetBytes={CHANNEL_TARGET}
              onError={(msg) => onNotice?.(msg)}
            />
            {/* 已满时说清为什么点不动，而不是让按钮静默无效 */}
            {full ? (
              <span className='text-[12px] text-muted-foreground'>已经有 {limit} 张了，删一张才能再传。</span>
            ) : null}
            {notice ? <span role='alert' className='text-[12px] text-destructive'>{notice}</span> : null}
            {addPending ? <span className='text-[12px] text-muted-foreground'>正在上传…</span> : null}
            {addError ? <span role='alert' className='text-[12px] text-destructive'>{addError}</span> : null}
            {removeError ? <span role='alert' className='text-[12px] text-destructive'>{removeError}</span> : null}
          </div>

          <div className='flex flex-col gap-2 border-t border-border pt-3'>
            <span className='text-[12px] font-medium text-foreground'>收款码可见性</span>
            {settingsPending ? (
              <span className='text-[12px] text-muted-foreground'>正在读设置…</span>
            ) : settingsError ? (
              <span role='alert' className='text-[12px] text-destructive'>{settingsError}</span>
            ) : settings ? (
              <>
                <Toggle checked={settings.show_channels} onChange={(e) => onShowChannels?.(e.target.checked)}>
                  在个人主页与帖子右栏展示我的收款码
                </Toggle>
                <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
                  开着 = 别人主页与帖子右栏都能看到这些码；关上只有你自己看得到。
                  <span className='text-foreground'>上传一张码会自动打开它</span>（D24），不用再回来点一次。
                </p>
                {saveError ? <span role='alert' className='text-[12px] text-destructive'>{saveError}</span> : null}
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** 收款码管理弹层的标题。**一处定义两处用**（弹层的 aria-label 与页内标题）。 */
export const PAYMENT_CHANNELS_TITLE = '赞赏与收款码';

/** 收款码管理弹层的说明（设置页那一格也用它，所以放在这里而不是各写一份）。 */
export const PAYMENT_CHANNELS_HINT =
  '站点不经手资金：这里只展示你挂的收款码，别人扫码付款后自己来登记一笔申报，你或管理员核对到账后才计入统计。';

/**
 * 就地弹层（D22）：个人主页那颗「设置我的收款码」不再跳 /settings#payment-channels。
 * 复用 Ring 的 Dialog（遮罩、Esc、焦点陷阱都由它负责），内容就是上面那个 View。
 */
export function PaymentChannelsDialog({
  open,
  onClose,
  ...view
}: PaymentChannelsViewProps & { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Dialog
      show
      modal
      trapFocus
      label={PAYMENT_CHANNELS_TITLE}
      showCloseButton
      onCloseAttempt={onClose}
      onOverlayClick={onClose}
      onEscPress={onClose}
      contentClassName='w-full max-w-[520px] p-5'
    >
      <div className='flex flex-col gap-3'>
        <h2 className='m-0 text-[15px] font-semibold text-foreground'>{PAYMENT_CHANNELS_TITLE}</h2>
        <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>{PAYMENT_CHANNELS_HINT}</p>
        <PaymentChannelsView {...view} />
      </div>
    </Dialog>
  );
}

/** 设置页那一格：就地把 View 摆进一张卡里（取数在 payment-channels-hook.ts）。 */
export function PaymentChannelsPanel(props: PaymentChannelsViewProps) {
  return (
    <section id='payment-channels' className='flex scroll-mt-20 flex-col gap-3 rounded-lg border border-border bg-card p-4'>
      <h2 className='m-0 text-[15px] font-semibold text-foreground'>{PAYMENT_CHANNELS_TITLE}</h2>
      <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>{PAYMENT_CHANNELS_HINT}</p>
      <PaymentChannelsView {...props} />
    </section>
  );
}
