// 方向 D / 小件：头像、类型徽标、置顶精华标记、数量行、权限三态。
// §7.2 允许自建「骨架与空状态」；控件（按钮/输入）一律来自 Ring UI。
import { CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import Avatar from '@jetbrains/ring-ui-built/components/avatar/avatar';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import type { Topic, TopicKind } from './data';
import { count, KIND_LABEL } from './data';

/* Ring UI 的 Avatar 只接受 16/18/20/24/28/32/40/48/56，其它值会让内置 fallback 抛错 */
export function User({ nickname, size }: { nickname: string; size: number }) {
  return <Avatar className='shrink-0' round size={size} username={nickname} />;
}

/** 类型徽标：细边框 + 小字，不用实心色块（实心会和数据图表头抢注意力）。 */
export function Kind({ kind, strong = false }: { kind: TopicKind; strong?: boolean }) {
  return (
    <span
      className={[
        'inline-flex shrink-0 items-center rounded-sm border px-1.5 py-px text-[11px] leading-4',
        strong && kind === 'resource' ? 'border-primary text-primary' : 'border-border text-muted-foreground',
      ].join(' ')}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

/** 置顶 / 精华：小标记 + 浅色，v1 卡片用。 */
export function Marks({ topic }: { topic: Topic }) {
  if (!topic.pinned && !topic.featured) return null;
  return (
    <span className='flex shrink-0 items-center gap-1.5'>
      {topic.pinned ? (
        <span className='inline-flex items-center gap-0.5 rounded-sm bg-primary px-1.5 py-px text-[10px] leading-4 font-medium text-primary-foreground'>
          置顶
        </span>
      ) : null}
      {topic.featured ? (
        <span className='inline-flex items-center gap-0.5 rounded-sm border border-primary/60 px-1.5 py-px text-[10px] leading-4 font-medium text-primary'>
          精华
        </span>
      ) : null}
    </span>
  );
}

/** 回复 / 赞 / 浏览：弱化小字，视觉只留图标 + 数字，指标名给读屏。 */
export function Metrics({ topic, className }: { topic: Topic; className?: string }) {
  return (
    <span className={['flex items-center gap-3 text-[12px] text-muted-foreground tabular-nums', className ?? ''].join(' ')}>
      <span className='flex items-center gap-1'>
        <span aria-hidden className='text-foreground/45'>回复</span>
        <span className='sr-only'>回复数</span>
        {count(topic.reply_count)}
      </span>
      <span className='flex items-center gap-1'>
        <span aria-hidden className='text-foreground/45'>赞</span>
        <span className='sr-only'>点赞数</span>
        {count(topic.like_count)}
      </span>
      <span className='flex items-center gap-1'>
        <span aria-hidden className='text-foreground/45'>阅</span>
        <span className='sr-only'>浏览数</span>
        {count(topic.view_count)}
      </span>
    </span>
  );
}

/** 骨架块：由视图自己摆位置，这里只给一个统一颜色的块。 */
export function Bar({ className }: { className?: string }) {
  return <div aria-hidden className={['rounded-sm bg-muted', className ?? ''].join(' ')} />;
}

/** 空态：与列表同宽，居中，给一个明确的下一步。 */
export function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className='flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-20 text-center'>
      <span className='rounded-full bg-muted p-3.5 text-muted-foreground'>
        <Inbox aria-hidden className='size-6' />
      </span>
      <p className='text-[17px] font-semibold text-foreground'>{title}</p>
      <p className='max-w-[26rem] text-[13px] leading-relaxed text-muted-foreground'>{hint}</p>
      <Button className='mt-1' primary>
        发布第一个主题
      </Button>
    </div>
  );
}

/** 错误态：错误码照前端方案 §5.2 写出来，重试只补缺的那部分。 */
export function Failed({ code, onRetry }: { code: string; onRetry: () => void }) {
  return (
    <div className='flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6' role='alert'>
      <p className='flex items-center gap-2 text-[15px] font-semibold text-foreground'>
        <CircleAlert aria-hidden className='size-5 text-destructive' />
        列表没能加载出来
      </p>
      <p className='text-[13px] leading-relaxed text-muted-foreground'>
        网络断了，或者服务端暂时不可用（错误码 {code}）。已加载的内容不会丢，重试只补缺的那部分。
      </p>
      <Button icon={RefreshCw} onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/** 到底文案：游标翻页结束时替换「加载更多」。 */
export function End({ total }: { total: number }) {
  return (
    <p className='py-8 text-center text-[12px] text-muted-foreground'>已经到底了 · 共 {total} 条主题</p>
  );
}
