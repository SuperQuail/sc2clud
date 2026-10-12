import { Link, Outlet } from 'react-router';
import { ThemeSwitcher } from '@/ui/theme-switcher';

// 布局壳：顶栏 / 内容 / 页脚。交互一律属于前端（前端方案 §1.3）
// 内容宽度：max-w-[1280px]（不是 Tailwind 的 max-w-5xl=1024 那一档的默认印象）。
// 为什么是这个数：帖子页是「贴吧式三栏」，信息流要求 1440 / 1200 档一行 ≥4 张方卡片——
// 两者都要在同一个容器里成立，1024/1100 都塞不下（1440 下中栏只剩 ~660px，卡片只有 ~230px）。
// 1280 是能同时满足的最小整数档；页面自己要更宽才允许外扩，不许再改这里。
export function Shell() {
  return (
    <div className='flex min-h-screen flex-col bg-background'>
      <header className='border-b border-border'>
        <div className='mx-auto flex h-14 w-full max-w-[1280px] items-center gap-6 px-4'>
          <Link className='font-semibold text-foreground' to='/'>SC2clud</Link>
          <nav className='flex gap-4 text-sm text-muted-foreground'>
            <Link to='/'>首页</Link>
            <Link to='/download'>下载</Link>
            <Link to='/search'>搜索</Link>
          </nav>
          <div className='ml-auto'>
            <ThemeSwitcher />
          </div>
        </div>
      </header>
      <main className='mx-auto w-full max-w-[1280px] flex-1 px-4 py-8'>
        <Outlet />
      </main>
      <footer className='border-t border-border py-6 text-center text-xs text-muted-foreground'>
        SC2clud
      </footer>
    </div>
  );
}
