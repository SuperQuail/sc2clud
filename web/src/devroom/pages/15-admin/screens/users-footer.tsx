import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { ChevronLeft } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import type { UsersCounts } from './users';

// 用户屏的分页条。**与 data-table.tsx 的 TableFooter 分家**：那个是房间演示件
// （文案写着「真实接口是游标分页，前端只保留加载更多或游标栈」，还有一个改 size 的按钮 ——
//  而 size 从来没进过请求，点了只换文案，是「看着能点、其实什么都没发生」）。
//
// 这里的口径：
//   · 共 N 条 = 服务端给的 counts.total（整个筛选结果集），不是本页行数；
//   · 页码不由本件改，只回调 onPage —— 游标栈在宿主手里，屏自己 +1 就会与数据对不上；
//   · 跳页只允许跳到「已经到过的下一页」（游标栈的能力上限，宿主给的 canNext 同理）。
export const PAGE_SIZE = 20;

export type UsersFooterProps = {
  counts: UsersCounts;
  /** 当前页码（1 起） */
  page: number;
  /** 游标栈里还有没有下一页 */
  canNext: boolean;
  onPage: (page: number) => void;
  /** 每页条数：真站传的是**请求里那个 limit**（不然页数就是个假数）；房间可以传小的来演示多页 */
  size?: number;
};

export function UsersFooter({ counts, page, canNext, onPage, size = PAGE_SIZE }: UsersFooterProps) {
  const [jump, setJump] = useState('');
  const pages = Math.max(1, Math.ceil(counts.total / size));
  // 游标栈只能往前走一步：跳页的上界 = 下一页（再远就没有游标可用了）
  const maxJump = Math.min(page + 1, pages);
  const want = Number(jump.trim());
  const jumpable = Number.isInteger(want) && want >= 1 && want <= maxJump && want !== page;

  // 提交后清空输入框：无效值留着会让人以为「已经跳过去了」
  const submit = () => {
    if (jumpable) onPage(want);
    setJump('');
  };

  return (
    // 两行：左列是口径（共 N 人 / 第几页），右列才是能点的东西。
    // 挤在一行时右列总宽 370px，而表格列只有 320px —— 实测「跳页」会被顶到右栏详情面板上。
    <div className='flex items-start justify-between gap-2 text-[12px] text-muted-foreground'>
      <span data-testid='users-page-info' className='min-w-0 whitespace-nowrap'>
        共 {counts.total} 人 · 第 {page} / {pages} 页 · 每页 {size} 条
      </span>
      <span className='flex flex-wrap items-center gap-1.5'>
        <Button
          inline={false}
          height={ControlsHeight.S}
          data-testid='users-prev'
          icon={icon16(ChevronLeft)}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </Button>
        <Button
          inline={false}
          height={ControlsHeight.S}
          data-testid='users-next'
          disabled={page >= pages || !canNext}
          onClick={() => onPage(page + 1)}
        >
          下一页
          {/* 图标放文字后面：Ring 的 Button 里 icon 永远在最前面，两颗图标会很挤 */}
        </Button>
        {/* 跳页这一组锁在 200px 内：Ring 的 Input 默认按容器撑开（实测 240px），不锁就会把「跳页」
            按钮顶出表格列、压在右栏详情面板上（1440 视口实测 20px 重叠）。 */}
        <span className='flex w-[200px] min-w-0 items-center gap-1'>
          <Input
            data-testid='users-jump'
            aria-label='跳页（输入页码后回车）'
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            inputClassName='min-w-0 flex-1'
            placeholder={'≤ ' + maxJump}
            height={ControlsHeight.S}
          />
          <Button data-testid='users-jump-go' inline={false} height={ControlsHeight.S} disabled={!jumpable} onClick={submit}>
            跳页
          </Button>
        </span>
      </span>
    </div>
  );
}
