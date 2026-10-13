// 赞助入口（右栏第一格）：看别人 = 打赏入口；看自己 = 「设置我的收款码」入口。
// 从 index.tsx 拆出来（该文件曾到 540 行，超过 500 的体量门禁）。
// 拆的是「一块自成一体、与页面其余部分只通过 props 交互」的东西 —— 不是为了过门禁而把文件切碎。
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Coffee, QrCode } from 'lucide-react';
import { icon16 } from '@/ui/icons';
const SPONSOR_CHANNELS = [
  { id: 'wechat', label: '微信', notice: '扫码后请在备注里写上你的昵称，作者好对上号。' },
  { id: 'alipay', label: '支付宝', notice: '支付宝扫码，备注可以留空。' },
  { id: 'afdian', label: '爱发电', notice: '爱发电支持一次性与按月两种，随你方便。' },
];

// 看别人主页 / 看自己主页是两种情形（isSelf 由页面内的 mock 开关给）：
//   别人 → 「赞助 TA」大按钮；自己 → 「设置我的收款码」（自己给自己打赏是荒谬的）。
// **没有收款码时整块不渲染**（用户 2026-10-13 定案，推翻了上一版「保留按钮 + 禁用」的判断）：
//   看别人主页时那一格是打赏入口，对方没挂收款码就没得打赏，留着禁用按钮只是噪声；
//   看自己主页时那一格是「设置我的收款码」入口，没有收款码才更需要它，所以照旧渲染。
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

function SponsorCard({ isSelf, channels }: SponsorDemo) {
  const view = SPONSOR_VIEW[isSelf ? 'self' : 'other'];
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(channels[0]?.id ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const [settingsHit, setSettingsHit] = useState(false);
  const active = channels.find((c) => c.id === activeId) ?? channels[0];
  // 别人的主页且没有收款码 → 整块不渲染（不是禁用按钮）。自己主页永远渲染。
  // 提前 return 必须在所有 hook 之后，否则 hook 调用顺序会变（react-hooks/rules-of-hooks）。
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
          onClick={() => (isSelf ? setSettingsHit(true) : setOpen((v) => !v))}
          className='!h-11 w-full !border-[var(--vivid-accent)] !bg-[var(--vivid-accent)] !text-[15px] !text-white'
        >
          <span className='inline-flex items-center gap-2'>
            <Coffee aria-hidden className='size-5' />
            {view.button}
          </span>
        </Button>
        <p className='text-[11px] leading-relaxed text-muted-foreground'>{view.hint}</p>

        {isSelf ? (
          settingsHit ? (
            <p className='rounded-md bg-muted/50 px-2 py-2 text-[11px] leading-relaxed text-muted-foreground'>
              已切到本页「设置」标签（mock）。真实页面会跳到个人设置的收款码分区。
            </p>
          ) : null
        ) : open ? (
          <div className='flex flex-col gap-3 border-t border-border pt-3'>
            <span className='flex flex-wrap items-center gap-1.5'>
              {channels.map((c) => (
                <Button key={c.id} ghost active={c.id === active?.id} onClick={() => setActiveId(c.id)}>
                  {c.label}
                </Button>
              ))}
            </span>

            <span className='flex flex-col items-center gap-2'>
              <span aria-hidden className='grid h-[132px] w-[132px] place-items-center rounded-md bg-muted ring-1 ring-border'>
                <QrCode aria-hidden className='size-16 text-muted-foreground' />
              </span>
              <span className='inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
                <QrCode aria-hidden className='size-3' />
                {active?.label}收款码 · 扫码或长按识别
              </span>
            </span>

            <p className='rounded-md bg-muted/50 px-2 py-2 text-[11px] leading-relaxed text-muted-foreground'>{active?.notice}</p>

            <Button
              inline={false}
              icon={confirmed ? icon16(Check) : undefined}
              disabled={confirmed}
              onClick={() => setConfirmed(true)}
              className='w-full'
            >
              {confirmed ? '已登记，等作者核对' : '我已完成打赏'}
            </Button>
            {confirmed ? (
              <p className='text-[11px] leading-relaxed text-muted-foreground'>
                已生成一条 pending 申报（POST /api/v1/rewards），作者确认收款、管理员核验后才会出现在 TA 的主页收入里。
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Island>
  );
}

// ?sponsor=other|none|self|self-none —— 只影响 DevRoom 的演示态：看别人/看自己 × 有/无收款码。
// 真实页面里 isSelf 由「当前登录者 handle 是否等于 /u/{handle}」决定，channels 来自
// GET /api/v1/users/{handle}/channels（作者关掉展示开关时后端返回空数组）。
type SponsorDemo = { isSelf: boolean; channels: Array<(typeof SPONSOR_CHANNELS)[number]> };

// 默认**本人**：这一页现在的入口（头像上传、改密码、退出登录）只在本人态存在，
// 初始落在「看别人」会让人以为它们没做。?sponsor=other|none 仍可切到别人态。
function readSelfView(): SponsorDemo {
  const v = new URLSearchParams(location.search).get('sponsor');
  if (v === 'none') return { isSelf: false, channels: [] };
  if (v === 'other') return { isSelf: false, channels: SPONSOR_CHANNELS };
  if (v === 'self-none') return { isSelf: true, channels: [] };
  return { isSelf: true, channels: SPONSOR_CHANNELS };
}

export { SPONSOR_CHANNELS, SponsorCard, readSelfView };
export type { SponsorDemo };
