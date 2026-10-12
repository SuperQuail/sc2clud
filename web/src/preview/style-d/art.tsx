// 方向 D / 封面图：内联 SVG 画出「有封面」的观感，不用任何图片字节。
// 为什么不用 <img src="data:...">：<img> 里的 SVG 拿不到 CSS 变量也拿不到 currentColor，
// 深色主题下会退成黑色（style-b 里实测过）。内联之后颜色就是令牌。
// 真项目这里换成 /img/<hash> 缩略图（固定宽高比容器，CLS=0，前端方案 §9.1）。
import { seedOf } from './data';

const INK = ['text-primary', 'text-foreground', 'text-muted-foreground'];

export type ArtKind = 'mesh' | 'grid';

/** v1：柔和的等高线（留白多、封面主导）。 */
function Mesh({ seed }: { seed: number }) {
  const rows = [0, 1, 2, 3, 4, 5];
  return (
    <svg aria-hidden className='size-full' focusable='false' preserveAspectRatio='xMidYMid slice' viewBox='0 0 1200 800'>
      <rect fill='currentColor' fillOpacity='.07' height='800' width='1200' />
      <circle cx={260 + (seed % 6) * 90} cy={300} fill='none' r={230} stroke='currentColor' strokeOpacity='.45' strokeWidth={26} />
      <circle cx={260 + (seed % 6) * 90} cy={300} fill='none' r={150} stroke='currentColor' strokeOpacity='.28' strokeWidth={14} />
      <circle cx={860 - (seed % 4) * 70} cy={520} fill='none' r={170} stroke='currentColor' strokeOpacity='.34' strokeWidth={18} />
      {rows.map((i) => (
        <path
          d={'M0 ' + String(700 + i * 22) + 'C 320 ' + String(650 - i * 26) + ', 620 ' + String(760 + i * 14) + ', 1200 ' + String(690 + i * 20)}
          fill='none'
          key={i}
          stroke='currentColor'
          strokeOpacity={0.3 - i * 0.04}
          strokeWidth={7}
        />
      ))}
      <path d='M945 150l120 0l0 120z' fill='currentColor' fillOpacity='.3' />
    </svg>
  );
}

/** v2：等距网格 + 旋转方块（更硬、更有信息感）。 */
function Grid({ seed }: { seed: number }) {
  const lines = [0, 150, 300, 450, 600, 750, 900, 1050, 1200];
  return (
    <svg aria-hidden className='size-full' focusable='false' preserveAspectRatio='xMidYMid slice' viewBox='0 0 1200 800'>
      <rect fill='currentColor' fillOpacity='.09' height='800' width='1200' />
      <g stroke='currentColor' strokeOpacity='.22' strokeWidth={3}>
        {lines.map((x) => (
          <line key={'v' + x} x1={x} x2={x} y1={0} y2={800} />
        ))}
        {[0, 200, 400, 600, 800].map((y) => (
          <line key={'h' + y} x1={0} x2={1200} y1={y} y2={y} />
        ))}
      </g>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i} transform={'translate(' + String(120 + i * 240) + ' ' + String(430 - (i % 2) * 130) + ') rotate(45)'}>
          <rect
            fill='none'
            height={150 + ((seed + i * 37) % 5) * 40}
            stroke='currentColor'
            strokeOpacity={0.5 - i * 0.06}
            strokeWidth={16}
            width={150 + ((seed + i * 37) % 5) * 40}
          />
        </g>
      ))}
    </svg>
  );
}

/** 主题封面。ratio 由外层容器控制（aspect-*），这里只管画。 */
export function TopicCover({ topicId, title, kind, className }: { topicId: string; title: string; kind: ArtKind; className?: string }) {
  const seed = seedOf(topicId + title);
  return (
    <div className={[className ?? '', 'overflow-hidden bg-muted', INK[seed % INK.length] ?? 'text-primary'].join(' ').trim()}>
      {kind === 'grid' ? <Grid seed={seed} /> : <Mesh seed={seed} />}
    </div>
  );
}

/** 主题无封面时的占位：只有一条细线纹，不抢标题。 */
export function NoCover({ className }: { className?: string }) {
  return (
    <div className={[className ?? '', 'overflow-hidden bg-muted/60 text-muted-foreground'].join(' ').trim()}>
      <svg aria-hidden className='size-full' focusable='false' preserveAspectRatio='none' viewBox='0 0 400 240'>
        <g stroke='currentColor' strokeOpacity='.16' strokeWidth={2}>
          {[24, 72, 120, 168, 216].map((y) => (
            <line key={y} x1={0} x2={400} y1={y} y2={y} />
          ))}
        </g>
      </svg>
    </div>
  );
}

/** 裸图案：给需要自己控制层级的地方用（v2 的全幅封面要把它当背景层再叠遮罩）。 */
export function Art({ seed, kind, className }: { seed: string; kind: ArtKind; className?: string }) {
  const n = seedOf(seed);
  return (
    <div className={className}>
      {kind === 'grid' ? <Grid seed={n} /> : <Mesh seed={n} />}
    </div>
  );
}

/** 分区封面（v1 的大卡）：图案 + 分区名首字，保证「新访客一眼知道这是哪个分区」。 */
export function BoardCover({ slug, name, className }: { slug: string; name: string; className?: string }) {
  return (
    <div className={[className ?? '', 'relative overflow-hidden bg-muted text-primary'].join(' ').trim()}>
      <Art className='absolute inset-0' kind='grid' seed={slug} />
      <span className='absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[8rem] leading-none font-semibold text-background/30 select-none'>
        {name.slice(0, 1)}
      </span>
    </div>
  );
}
