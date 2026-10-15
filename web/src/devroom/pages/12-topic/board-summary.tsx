import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { MessageSquare, Star, UserPlus } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { BoardCover } from '@/devroom/pages/03-navigation/board-rail';
import type { Board } from './types';

// 右栏第一格：分区简介。顺序照「先是什么、再有多大、最后能做什么」——
// 名称 + 一句话简介 + 四个统计 + 关注按钮；分区封面缩在左上角当视觉锚点，不占一整屏。
// 数字口径与后端 §21.2 的 board 字段一致（topic_count / post_count / today_count / member_count）。
// 分区内导航不在这里重复一遍（左栏已有）：同一个筛选在一屏里出现两处，人会以为它们不同步。
// 「发帖」的地址与「关注分区」的动作由宿主给：房间指房间里的发帖页，真站指 /new?board=；
// 关注分区后端还没有端点，所以 onJoin 不传时这颗按钮就没有动作（真站传一次回执，不许静默）。
export function BoardSummary({
  board,
  composeHref,
  onJoin,
}: {
  board: Board;
  composeHref: string;
  onJoin?: () => void;
}) {
  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
      <div className='flex items-start gap-3'>
        {/* 封面走**唯一那份** BoardCover（03-navigation）：占位、/img/ 前缀、稳定色相都在它那里。
            这里原来自己拼 <img src={board.cover}> —— 而 cover 这一列 BoardDTO 里根本没有（真名 cover_hash），
            所以帖子页右栏的分区封面与左栏一起恒为空（D21）。 */}
        <BoardCover slug={board.slug} name={board.name} hash={board.cover_hash} className='size-10 rounded-md text-[15px]' />
        <div className='flex min-w-0 flex-1 flex-col gap-1'>
          <h2 className='truncate text-[15px] font-semibold text-foreground'>{board.name}</h2>
          <p className='text-[12px] leading-relaxed text-muted-foreground'>{board.description}</p>
        </div>
      </div>

      {/* 四个数字在 248px 栏里只有 ~52px 一格：11px 标签 + 15px 数字是能放下的下限 */}
      <dl className='grid grid-cols-4 gap-1 border-y border-border px-1 py-2 text-center'>
        <Stat label='帖子' value={board.topic_count} />
        <Stat label='回复' value={board.post_count} />
        <Stat label='今日' value={board.today_count} />
        <Stat label='成员' value={board.member_count} />
      </dl>

      {/* D9：动作两件独占一行、且与下面的权限说明留出间隔。
          为什么为这一点写一段注释：右栏是 248px 的窄栏，「关注」这一颗按钮与**下一格作者卡的头像/徽章**
          在纵向只隔 16px，而两者在横向重叠 38px（2026-10-14 实测 1440/1000/700 三个视口都是这个数）——
          截图里看就是「关注被徽章压住」的样子。几何上从来没有真重叠（扫描见进度文件的证据），
          但把两组分清楚的成本只有一行 class，而含混的代价是一次误报。 */}
      <div data-testid='board-actions' className='flex flex-wrap items-center gap-2 border-t border-border pt-3'>
        {/* inline={false} 必须显式写：Ring UI 只要看到 icon 就把按钮排成 inline（链接样式），
            primary 的填充会被压掉、height 档位也失效 —— 实测改前 bg 透明、颜色是链接蓝。 */}
        <Button
          primary
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(board.joined ? Star : UserPlus)}
          onClick={onJoin}
        >
          {board.joined ? '已关注' : '关注分区'}
        </Button>
        {/* 「写帖页」原来是 protoTitle（不可导航，因为房间里没有那一页）。18-compose 建好之后
            它必须变成真链接：房间内一律 ?page=（旧站域名下 /new、/settings 这类路径会 404）。 */}
        <Button href={composeHref}>发帖</Button>
      </div>

      {/* 只留一行权限说明：成员数上面统计格里已经有了，写第三遍没有信息量，窄栏里还会折行 */}
      <p className='flex items-center gap-1.5 border-t border-border pt-3 text-[11px] text-muted-foreground'>
        <MessageSquare aria-hidden className='size-3 shrink-0' />
        游客可读，发帖需登录
      </p>
    </section>
  );
}

// 四个统计共用一格：数字在上、标签在下（贴吧的口径），数字用 tabular-nums 防跳动
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className='flex flex-col'>
      <dt className='order-2 text-[11px] text-muted-foreground'>{label}</dt>
      <dd className='order-1 text-[15px] font-semibold tabular-nums text-foreground'>{value}</dd>
    </div>
  );
}