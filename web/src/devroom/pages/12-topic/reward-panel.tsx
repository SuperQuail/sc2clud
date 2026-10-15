import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { ChevronDown, ChevronUp, Coffee } from 'lucide-react';
import { useState } from 'react';
import { DonateBox } from './donate-box';
import type { PaymentChannel } from '@/lib/api/rewards';

// 帖子右栏的赞助格。**醒目**：用 --vivid-accent（设计令牌里唯一的强调色），
// 但这是一次点击展开、不是常驻红块 —— 打赏入口压在正文旁边天天闪会变成广告位。
// 展开后的内容全在 DonateBox 里（与个人主页的 SponsorCard 共用同一份，见那个文件的头注）。
//
// 2026-10-14（L1）：这一格原先只吃 DevRoom 的假渠道（`qr_url` + 每渠道一个 `notice`，后端两样都没有），
// 真站传的是恒空数组。现在它吃的是 `GET /users/{handle}/channels` 的真数据，
// 提示文案是 `user_donation_settings.notice_text`（后端没有「每渠道一句提示」这一列）。
export function RewardPanel({
  channels,
  notice,
  isSelf = false,
  profileHref,
  onDonate,
  donationPending,
  donationError,
  donationDone,
  loginHref,
  loggedIn = false,
}: {
  channels: PaymentChannel[];
  notice?: string;
  /** 看自己的帖子时（作者本人）不显示打赏位 —— 自己给自己打赏后端直接 400 */
  isSelf?: boolean;
  /** 本人时「去我的主页挂码」的去处（D22 之后收款码的管理界面在主页右栏那个弹层里） */
  profileHref?: string;
  onDonate?: (v: { channelId: string; amountCents: number }) => void;
  donationPending?: boolean;
  donationError?: string | null;
  donationDone?: string | null;
  loginHref?: string;
  loggedIn?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4'>
      {/* 用户要求「更醒目、大一些」：48px 高 + 15px 粗体 + 橙底白字。
          图标**不走 Ring 的 icon prop**——那个位置是 16px 固有尺寸的坑（registry button notes），
          18/20px 的图标会把行高顶歪；所以图标与文字自己用 inline-flex 排，Button 只当容器。
          !h-12 覆盖的是 Ring 的 ring-button-heightL，它是普通类，Tailwind 的 ! 优先级更高。 */}
      <Button
        primary
        inline={false}
        height={ControlsHeight.L}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className='!h-12 w-full !rounded-lg !border-[var(--vivid-accent)] !bg-[var(--vivid-accent)] text-[15px] font-semibold !text-white hover:!bg-[color-mix(in_srgb,var(--vivid-accent)_88%,black)]'
      >
        <span className='inline-flex w-full items-center justify-center gap-2'>
          <Coffee aria-hidden className='size-5 shrink-0' />
          {isSelf ? '我的赞助' : '赞助作者'}
          {open ? (
            <ChevronUp aria-hidden className='size-4 shrink-0' />
          ) : (
            <ChevronDown aria-hidden className='size-4 shrink-0' />
          )}
        </span>
      </Button>
      <p className='text-[11px] leading-relaxed text-muted-foreground'>
        打赏是纯自愿的，不解锁任何东西；资源永远免费。
      </p>

      {open ? (
        <div className='flex flex-col gap-3 border-t border-border pt-3'>
          <DonateBox
            channels={channels}
            notice={notice}
            isSelf={isSelf}
            profileHref={profileHref}
            onDonate={onDonate ?? (() => undefined)}
            pending={donationPending}
            error={donationError}
            done={donationDone}
            loggedIn={loggedIn}
            loginHref={loginHref}
          />
        </div>
      ) : null}
    </section>
  );
}
