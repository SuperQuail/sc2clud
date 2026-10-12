import { Link, Outlet } from 'react-router';
import { ThemeSwitcher } from '@/ui/theme-switcher';

// 布局壳：顶栏 / 内容 / 页脚。交互一律属于前端（前端方案 §1.3）
export function Shell() {
  return (
    <div className='flex min-h-screen flex-col bg-background'>
      <header className='border-b border-border'>
        <div className='mx-auto flex h-14 max-w-5xl items-center gap-6 px-4'>
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
      <main className='mx-auto w-full max-w-5xl flex-1 px-4 py-8'>
        <Outlet />
      </main>
      <footer className='border-t border-border py-6 text-center text-xs text-muted-foreground'>
        SC2clud
      </footer>
    </div>
  );
}
