import Button from '@jetbrains/ring-ui-built/components/button/button';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';
import { CircleAlert, Lock, ServerCrash } from 'lucide-react';
import { apiErrorLine, isApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { Empty } from '@/ui/state/empty';

// 空态的唯一实现在 @/ui/state/empty（DevRoom 的 14-home 也在用它）——这里只做转出，
// 让 8 个产品路由继续 import { Empty } from './_parts/state' 而不用动。
export { Empty };

// 信息流两种视图的栅格：首页与分区页**必须逐字相同**（列数断点不一致，两页来回切会看到卡片跳宽窄）。
// 2026-10-14 收口：原先 routes/home.tsx、routes/board.tsx、devroom/pages/14-home/index.tsx 各有一份逐字相同的
// 定义，靠注释互相提醒「要与另一页一致」—— 那种约定没有落点，第三次改就会漏一处。
export const GRID = {
  card: 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
  compact: 'flex flex-col gap-0.5',
} as const;

// 每页三态的**唯一实现**（上线设计 P2 决策 5：加载 / 空 / 错误必须有，不许白屏）。
// 为什么收在一处：DevRoom 吃过「一页缺一个态就是一片白」的亏，而页面越多越会有人漏掉某一态。
// 判据是「有没有数据」，所以判断留给调用方（query.isPending / isError / items.length），这里只管画。

/** 加载态：Ring 的 LoaderInline + 一句说明。**不做骨架屏**（骨架要按每页形状现画，那是各页自己的事）。 */
export function Loading({ what = '内容', className }: { what?: string; className?: string }) {
  return (
    <div
      role='status'
      aria-live='polite'
      className={cn('flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground', className)}
    >
      <LoaderInline />
      正在加载{what}…
    </div>
  );
}

/**
 * 错误态：**必须能看出是哪一类错误**，且 5xx 要带 request_id（前端方案 §5.2：
 * 用户报错时能对日志，否则那条日志永远找不到）。
 * 401 / 403 / 404 各有自己的话术：把「我没登录」说成「服务器错误」会让人白等。
 */
export function ErrorState({
  error,
  what = '内容',
  onRetry,
  className,
}: {
  error: unknown;
  what?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const api = isApiError(error) ? error : null;
  const status = api?.status ?? 0;
  const title =
    status === 0
      ? '网络不可用'
      : status === 401
        ? '需要先登录'
        : status === 403
          ? '没有权限'
          : status === 404
            ? '不存在或已被删除'
            : status === 429
              ? '请求太频繁'
              : status >= 500
                ? '服务器开小差了'
                : '加载失败';
  const Icon = status === 403 || status === 401 ? Lock : status >= 500 || status === 0 ? ServerCrash : CircleAlert;
  const detail = api ? apiErrorLine(api) : '未知错误：' + String(error);
  const retryAfter = api?.retryAfterMs ? Math.ceil(api.retryAfterMs / 1000) + ' 秒后可以再试。' : '';

  return (
    <div
      role='alert'
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-6 py-14 text-center',
        className,
      )}
    >
      <Icon aria-hidden className='size-7 text-destructive' />
      <span className='text-[15px] text-foreground'>
        {title}（{what}没能加载）
      </span>
      <span className='max-w-[52ch] text-[13px] leading-relaxed text-muted-foreground'>
        {retryAfter}
        {detail}
      </span>
      {onRetry ? (
        <span className='pt-1'>
          <Button data-testid='retry' onClick={onRetry}>
            重试
          </Button>
        </span>
      ) : null}
    </div>
  );
}
