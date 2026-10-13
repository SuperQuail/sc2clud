import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Check, ChevronDown, ChevronUp, Coffee, QrCode } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { PaymentChannel } from './types';

// 赞助入口。**醒目**：用 --vivid-accent（设计令牌里唯一的强调色），
// 但这是一次点击展开、不是常驻红块——打赏入口压在正文旁边天天闪会变成广告位。
// 展开后的面板：渠道切换（一张码 = 一个渠道）→ 收款码 + 提示文案 → 「我已完成打赏」登记入口（mock）。
export function RewardPanel({ channels }: { channels: PaymentChannel[] }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(channels[0]?.id ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const active = channels.find((c) => c.id === activeId) ?? channels[0];

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
          赞助作者
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
          {channels.length === 0 ? (
            <p className='text-[12px] text-muted-foreground'>作者还没开启收款码。</p>
          ) : (
            <>
              <span className='flex flex-wrap items-center gap-1.5'>
                {channels.map((c) => (
                  <Button key={c.id} ghost active={c.id === active?.id} onClick={() => setActiveId(c.id)}>
                    {c.label}
                  </Button>
                ))}
              </span>

              <span className='flex flex-col items-center gap-2'>
                <QrTile seed={active?.id ?? 'qr'} />
                <span className='inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
                  <QrCode aria-hidden className='size-3' />
                  {active?.label}收款码 · 长按或扫码
                </span>
              </span>

              <p className='rounded-md bg-muted/50 px-2 py-2 text-[11px] leading-relaxed text-muted-foreground'>
                {active?.notice}
              </p>

              <Button
                inline={false}
                height={ControlsHeight.M}
                icon={confirmed ? icon16(Check) : undefined}
                disabled={confirmed}
                onClick={() => setConfirmed(true)}
                className='w-full'
              >
                {confirmed ? '已登记，等待核验' : '我已完成打赏'}
              </Button>
              {confirmed ? (
                <p className='text-[11px] leading-relaxed text-muted-foreground'>
                  已生成一条 pending 记录（POST /api/v1/rewards），管理员在后台人工核对后会在你的主页显示。
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

// 收款码：真实值是后端回的 /img/<hash>。这里没有真图，用**确定性的伪二维码**占位——
// 随机点阵每次渲染都一样（种子取渠道 id），比一张灰色占位图更能看出「这里是一张码」。
// shortcut: 只画了三个定位角 + 伪点阵，不是可扫描的真码；接后端 /img/<hash> 时整块删掉。
const SIZE = 21;
const CELL = 11;

function QrTile({ seed }: { seed: string }) {
  return (
    <span
      aria-hidden
      className='grid rounded-sm bg-white p-2 ring-1 ring-border'
      style={{ gridTemplateColumns: 'repeat(' + SIZE + ', ' + CELL + 'px)' }}
    >
      {Array.from({ length: SIZE * SIZE }, (_, i) => (
        <span
          key={i}
          style={{
            width: CELL,
            height: CELL,
            backgroundColor: on(i, seed) ? 'var(--foreground)' : 'transparent',
          }}
        />
      ))}
    </span>
  );
}

function on(index: number, seed: string): boolean {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  if (finder(row, col)) {
    // 定位角：7×7 实心 + 中间 3×3 挖空（真码的结构，一眼能认出来是二维码）
    const r = row < 7 ? row : SIZE - 1 - row;
    const c = col < 7 ? col : SIZE - 1 - col;
    const ring = r === 0 || r === 6 || c === 0 || c === 6;
    const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    return ring || core;
  }
  let h = 2166136261;
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  h = Math.imul(h ^ (row * 31 + col), 16777619);
  return ((h >>> 13) & 1) === 1;
}

function finder(row: number, col: number): boolean {
  return (row < 7 && col < 7) || (row < 7 && col >= SIZE - 7) || (row >= SIZE - 7 && col < 7);
}
