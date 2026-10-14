import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { QrCode } from 'lucide-react';
import { imagePath } from '@/lib/url';
import type { PaymentChannel } from '@/lib/api/rewards';

// 打赏面板的**唯一一份**内容：渠道切换 → 收款码 → 金额 → 「我已完成打赏」登记申报。
// 个人主页的 `SponsorCard` 与帖子右栏的 `RewardPanel` 都长这样，所以抽出来一份
// （两份实现必然在字距与空态上分叉）。外层的壳由各自的宿主给：一个是 Island、一个是 section。
//
// 三件事实照后端，不照设计稿：
//   · 收款码的图是 `/img/<hash>`（站根路径）→ 必须过 `imagePath`（dev 前缀下不过会拿到 SPA 的 HTML）；
//   · 后端**没有**「渠道提示文案」这一列：提示是 `user_donation_settings.notice_text`（或站点默认），
//     所以它是 props.notice 而不是渠道上的字段（DevRoom 的 mock 里那个 `notice` 后端没有）；
//   · 「我已完成打赏」是**申报**（POST /rewards），不是付款 —— 站点不经手资金，钱是扫码直接给作者的。

/** 金额选择：整数元，1–999999.99（后端 `amount_cents` 是 min=1 max=99999999）。 */
const PRESETS = [5, 10, 30, 100];

export function DonateBox({
  channels,
  notice,
  isSelf,
  settingsHref,
  onDonate,
  pending,
  error,
  done,
  loginHref,
  loggedIn,
}: {
  channels: PaymentChannel[];
  /** 作者的提示文案（关掉提示时后端给空串）；没有就不渲染那一行 */
  notice?: string;
  isSelf: boolean;
  /** 看自己时那一格是「设置我的收款码」的入口 */
  settingsHref: string;
  onDonate: (v: { channelId: string; amountCents: number }) => void;
  pending?: boolean;
  error?: string | null;
  /** 申报成功的回执（提交后显示；换渠道或改金额不清它，避免用户以为没提交成功） */
  done?: string | null;
  loginHref?: string;
  loggedIn: boolean;
}) {
  const [activeId, setActiveId] = useState(channels[0]?.id ?? '');
  const [yuan, setYuan] = useState('');
  const active = channels.find((c) => c.id === activeId) ?? channels[0];
  const cents = Math.round(Number(yuan) * 100);
  const valid = Number.isFinite(cents) && cents >= 1 && cents <= 99_999_999;

  // 看自己：这一格是入口，不是打赏位（自己给自己打赏后端会直接 400）
  if (isSelf) {
    return (
      <div className='flex flex-col gap-2'>
        <Button inline={false} height={ControlsHeight.M} href={settingsHref} className='w-full'>
          设置我的收款码
        </Button>
        <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
          收款码在个人设置里挂；打赏渠道随时可关，关掉后别人主页与帖子右栏都不再显示这个入口。
        </p>
      </div>
    );
  }

  // 别人没挂码（或关掉了展示）：后端回空数组 —— 不给一颗点了必然失败的按钮
  if (channels.length === 0) {
    return <p className='m-0 text-[12px] text-muted-foreground'>作者还没开启收款码。</p>;
  }

  return (
    <div className='flex flex-col gap-3'>
      {channels.length > 1 ? (
        <span className='flex flex-wrap items-center gap-1.5'>
          {channels.map((c) => (
            <Button key={c.id} ghost active={c.id === active?.id} onClick={() => setActiveId(c.id)}>
              {c.label}
            </Button>
          ))}
        </span>
      ) : null}

      <span className='flex flex-col items-center gap-2'>
        <img
          src={active ? imagePath(active.image) : ''}
          alt={(active?.label ?? '') + '收款码'}
          width={160}
          height={160}
          className='size-40 rounded-md bg-white object-contain ring-1 ring-border'
        />
        <span className='inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
          <QrCode aria-hidden className='size-3' />
          {active?.label}收款码 · 扫码或长按识别
        </span>
      </span>

      {notice ? (
        <p className='m-0 rounded-md bg-muted/50 px-2 py-2 text-[11px] leading-relaxed text-muted-foreground'>{notice}</p>
      ) : null}

      {loggedIn ? (
        <>
          <span className='flex flex-wrap items-center gap-1.5'>
            {PRESETS.map((y) => (
              <Button key={y} ghost active={Number(yuan) === y} onClick={() => setYuan(String(y))}>
                {'¥' + y}
              </Button>
            ))}
          </span>
          <Input
            value={yuan}
            onChange={(e) => setYuan(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode='decimal'
            label='金额（元）'
            data-testid='donate-amount'
            placeholder='10'
            help='整数元即可；小数点后两位以内。'
          />
          <Button
            data-testid='donate-submit'
            inline={false}
            height={ControlsHeight.M}
            primary
            disabled={!valid || pending}
            loader={pending}
            onClick={() => {
              if (valid && active) onDonate({ channelId: active.id, amountCents: cents });
            }}
            className='w-full'
          >
            {valid ? '我已完成 ¥' + (cents / 100).toFixed(2) + ' 的打赏' : '先填金额'}
          </Button>
        </>
      ) : (
        <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>
          打赏完要登记一笔申报才有记录，而申报要登录（后端 POST /rewards 需要登录）。
          {loginHref ? (
            <a href={loginHref} className='underline'>
              去登录
            </a>
          ) : null}
        </p>
      )}

      {error ? (
        <span role='alert' className='text-[11px] leading-relaxed text-destructive'>
          {error}
        </span>
      ) : null}
      {done ? <p className='m-0 text-[11px] leading-relaxed text-muted-foreground'>{done}</p> : null}
    </div>
  );
}
