import type { ReactNode } from 'react';
import { Link } from 'react-router';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { fetchBoards } from '@/lib/api/forum';
import { BoardRail as BoardRailView, type RailLink } from '@/devroom/pages/03-navigation/board-rail';
import { boardRows } from './mappers';

// 页面级的两个小件（**不是控件**，是版式）：页头（标题 + 描述 + 动作）与分区侧栏。
// 它们放在 routes/_parts 而不是 src/ui：src/ui 是「控件库」，加控件要走 DevRoom 验证 + 登记
// （开发必读 §11），而这两个只是三四个页面的版式，不是控件。要提升成控件时先登记。

export function PageHeader({
  title,
  description,
  actions,
  backTo,
  backLabel,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 返回上一个列表（帖子页、设置页都要） */
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <header className='flex flex-wrap items-end justify-between gap-3'>
      <div className='flex min-w-0 flex-col gap-1'>
        {backTo ? (
          <Link
            to={backTo}
            className='inline-flex w-fit items-center gap-1 rounded-[3px] text-[12px] text-muted-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
          >
            <ArrowLeft aria-hidden className='size-3.5' />
            {backLabel ?? '返回'}
          </Link>
        ) : null}
        <h1 className='m-0 text-[20px] font-semibold text-foreground'>{title}</h1>
        {description ? <p className='m-0 text-[13px] text-muted-foreground'>{description}</p> : null}
      </div>
      {actions}
    </header>
  );
}

/** 发帖入口：全站只有这一处拼它的路径与图标（首页、分区页、帖子页都要一颗）。 */
export function ComposeButton({ board, label = '发帖' }: { board?: string; label?: string }) {
  return (
    <Button
      primary
      inline={false}
      height={ControlsHeight.M}
      icon={icon16(Plus)}
      href={appPath('new' + (board ? '?board=' + encodeURIComponent(board) : ''))}
    >
      {label}
    </Button>
  );
}

/**
 * 分区侧栏的**宿主**：只取数、把数据喂给 View（清单 §0：版面在 View 里，这里只传参）。
 *
 * 版式与占位在 `@/devroom/pages/03-navigation/board-rail`（DevRoom 03-navigation 与产品页渲染的是**同一个文件**）。
 * 分区列表走 GET /boards（全站只有这一处请求它，staleTime 10 分钟在 lib/query/client.ts 里定）。
 *
 * 字段名照后端 BoardDTO（forum/internal/forum/dto.go:38）：**cover_hash 是裸哈希**（不是路径），
 * 空串 = 这个分区没有封面（真站五个分区现在全是空串 —— 迁移没迁封面，见进度-FIX-IMG 的 D3）。
 */
export function BoardRail({ current, className }: { current?: string; className?: string }) {
  const boards = useQuery({ queryKey: qk.boards(), queryFn: ({ signal }) => fetchBoards(signal), staleTime: 10 * 60_000 });
  if (!boards.data || boards.data.length === 0) return null;
  return <BoardRailView boards={boardRows(boards.data)} current={current} className={className} link={RailRouterLink} />;
}

/** 把 react-router 的 `<Link to>` 适配成 View 要的 `{ href }`：View 因此不认识路由库。 */
export function RailRouterLink({ href, ...rest }: Parameters<RailLink>[0]) {
  // Link 的 to 是 **basename 相对**的（appPath 的结果已经含 /dev 前缀，再给 Link 会变成 /dev/dev/…）
  return <Link to={routePath(href)} {...rest} />;
}
