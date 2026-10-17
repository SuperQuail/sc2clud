import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { icon16 } from '@/ui/icons';

// **顶栏的搜索**（D11）：点它**不换页**，就在顶部把搜索栏展开并聚焦，结果就地下拉。
//
// 用户原话：「点顶栏「搜索」现在跳回主页；要的是不换页、顶部就地展开搜索栏并聚焦」。
// 所以这里没有导航、没有 href —— 只有开合与一个浮层。
//
// 它放在 src/ui/nav/ 是因为**产品里唯一的使用点是 app/shell.tsx**（Lead 专属文件，我不改）：
// 接线方式就是把这个件放到顶栏那一行里，替掉现在那颗「跳到首页」的链接：
//
//     -  <Button ghost inline={false} height={ControlsHeight.S} href={appPath('')} icon={icon16(Search)}>搜索</Button>
//     +  <HeaderSearch />
//
// 为什么结果用**懒加载**：结果区就是首页那一块搜索面板（19-search 的 SearchPanel），它为了 Tabs
// 静态拖进 react-virtualized 一条链（53 KB gzip，实测见 routes/home.tsx）。顶栏属于首屏，
// 所以没点开搜索的人不该为它付流量。
const LazyResults = lazy(() =>
  import('./header-search-results').then((m) => ({ default: m.HeaderSearchResults })),
);

export function HeaderSearch({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // 点外面关掉、Esc 关掉：都是「就地展开」的一部分（不然它会一直压在页面上）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node | null;
      if (el && box.current && !box.current.contains(el)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    // relative：浮层挂在**这颗按钮**上（挂到 header 需要改 shell 的 class，而那个文件不是我的）
    <div ref={box} className={cn('relative', className)}>
      <Button
        data-testid='header-search-toggle'
        ghost
        inline={false}
        height={ControlsHeight.S}
        icon={icon16(open ? X : Search)}
        aria-expanded={open}
        aria-label={open ? '收起搜索' : '搜索'}
        title={open ? '收起搜索' : '搜索（不换页，就地展开）'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '收起' : '搜索'}
      </Button>

      {open ? (
        <div
          data-testid='header-search-panel'
          className='absolute top-[calc(100%+6px)] left-0 z-50 w-[min(40rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 shadow-lg'
        >
          <Suspense fallback={<span className='block px-1 py-2 text-[13px] text-muted-foreground'>正在打开搜索…</span>}>
            <LazyResults onClose={() => setOpen(false)} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
