// 赞助入口（右栏第一格）：看别人 = 打赏入口；看自己 = 「设置我的收款码」入口。
// 从 index.tsx 拆出来（该文件曾到 540 行，超过 500 的体量门禁）。
// 拆的是「一块自成一体、与页面其余部分只通过 props 交互」的东西 —— 不是为了过门禁而把文件切碎。
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { useState } from 'react';
import { ChevronDown, ChevronUp, Coffee } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { DonateBox } from '@/devroom/pages/12-topic/donate-box';
import type { PaymentChannel } from '@/lib/api/rewards';

// 看别人主页 / 看自己主页是两种情形（真站里 isSelf 由「当前登录者 handle 是否等于 /u/{handle}」给）：
//   别人 → 「赞助 TA」大按钮；自己 → 「设置我的收款码」（自己给自己打赏后端会 400）。
// **没有收款码时整块不渲染**（用户 2026-10-13 定案，推翻了上一版「保留按钮 + 禁用」的判断）：
//   看别人主页时那一格是打赏入口，对方没挂收款码就没得打赏，留着禁用按钮只是噪声；
//   看自己主页时那一格是「设置我的收款码」入口，没有收款码才更需要它，所以照旧渲染。
//
// 2026-10-14（L1）：整块接真数据。删掉了 `disableReason` 那个逃生口 ——
// 它存在的理由是「后端没有收款码列、没有 GET /users/{handle}/channels、没有 POST /rewards」，
// 而这三样**后端一直都有**（media 域 + reward 域），缺的是前端客户端。逃生口留着只会掩盖漏接。
type SponsorView = { heading: string; button: string; hint: string };
const SPONSOR_VIEW: Record<'other' | 'self', SponsorView> = {
  other: {
    heading: '赞助 TA',
    button: '赞助 TA',
    hint: '打赏是纯自愿的，不解锁任何东西。',
  },
  self: {
    heading: '我的赞助',
    button: '设置我的收款码',
    hint: '收款码在个人设置里挂；打赏渠道随时可关，关掉后别人主页上不显示这个入口。',
  },
};

function SponsorCard({
  isSelf,
  channels,
  notice,
  settingsHref = '',
  onDonate,
  donationPending,
  donationError,
  donationDone,
  loginHref,
  loggedIn = false,
}: SponsorDemo & {
  /** 作者的提示文案（user_donation_settings.notice_text；后端没有「每渠道一句」这一列） */
  notice?: string;
  settingsHref?: string;
  onDonate?: (v: { channelId: string; amountCents: number }) => void;
  donationPending?: boolean;
  donationError?: string | null;
  donationDone?: string | null;
  loginHref?: string;
  loggedIn?: boolean;
}) {
  const view = SPONSOR_VIEW[isSelf ? 'self' : 'other'];
  const [open, setOpen] = useState(false);
  // 别人的主页且没有收款码 → 整块不渲染（不是禁用按钮）。自己主页永远渲染。
  if (!isSelf && channels.length === 0) return null;

  return (
    <Island withoutPaddings>
      <div className='flex flex-col gap-2 p-4'>
        <span className='text-[12px] font-medium tracking-wide text-muted-foreground'>{view.heading}</span>
        {/* 大按钮（≥44px、橙底白字）：图标走 children 里的 span——icon16 会把它压成 16px；
            高度与字号用 ! 覆盖 Ring 的默认值；inline={false} 才能拿到整块宽度。 */}
        <Button
          inline={false}
          primary
          aria-expanded={isSelf ? undefined : open}
          iconRight={!isSelf ? icon16(open ? ChevronUp : ChevronDown) : undefined}
          onClick={() => (isSelf ? undefined : setOpen((v) => !v))}
          href={isSelf ? settingsHref : undefined}
          className='!h-11 w-full !border-[var(--vivid-accent)] !bg-[var(--vivid-accent)] !text-[15px] !text-white'
        >
          <span className='inline-flex items-center gap-2'>
            <Coffee aria-hidden className='size-5' />
            {view.button}
          </span>
        </Button>
        <p className='text-[11px] leading-relaxed text-muted-foreground'>{view.hint}</p>

        {isSelf ? null : open ? (
          <div className='flex flex-col gap-3 border-t border-border pt-3'>
            <DonateBox
              channels={channels}
              notice={notice}
              isSelf={false}
              settingsHref={settingsHref}
              onDonate={onDonate ?? (() => undefined)}
              pending={donationPending}
              error={donationError}
              done={donationDone}
              loggedIn={loggedIn}
              loginHref={loginHref}
            />
          </div>
        ) : null}
      </div>
    </Island>
  );
}

// ?sponsor=other|none|self|self-none —— 只影响 DevRoom 的演示态：看别人/看自己 × 有/无收款码。
// 字段名照 @/lib/api/rewards 的 PaymentChannel（image 是 /img/<hash>，不是设计稿的 qr_url）。
// 房间里没有真图：`mock://` 这种 scheme 会被 imagePath 原样返回，在 <img> 上就是一格裂图，
// 所以给一条真形状的地址（房间里本来也没有后端，它照样是坏图，但形状是真的）。
const SPONSOR_CHANNELS: PaymentChannel[] = [
  { id: 'wechat', label: '微信', image: '/img/roomdemo-wechat', sort: 0 },
  { id: 'alipay', label: '支付宝', image: '/img/roomdemo-alipay', sort: 1 },
  { id: 'afdian', label: '爱发电', image: '/img/roomdemo-afdian', sort: 2 },
];
const SPONSOR_NOTICE = '扫码后请在备注里写上你的昵称，作者好对上号；打赏是纯自愿的，不影响资源更新。';

/** 房间的演示态（真站里 `isSelf` 来自会话、`channels` 来自接口，这个类型只用于房间）。 */
type SponsorDemo = { isSelf: boolean; channels: PaymentChannel[] };

// 默认**本人**：这一页现在的入口（头像上传、改密码、退出登录）只在本人态存在，
// 初始落在「看别人」会让人以为它们没做。?sponsor=other|none 仍可切到别人态。
function readSelfView(): SponsorDemo {
  const v = new URLSearchParams(location.search).get('sponsor');
  if (v === 'none') return { isSelf: false, channels: [] };
  if (v === 'other') return { isSelf: false, channels: SPONSOR_CHANNELS };
  if (v === 'self-none') return { isSelf: true, channels: [] };
  return { isSelf: true, channels: SPONSOR_CHANNELS };
}

export { SPONSOR_CHANNELS, SPONSOR_NOTICE, SponsorCard, readSelfView };
export type { SponsorDemo };
