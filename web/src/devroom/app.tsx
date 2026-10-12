import Button from '@jetbrains/ring-ui-built/components/button/button';
import { VERIFIED } from './registry';
import { appPath } from '@/lib/url';
import InteractivePage from './pages/01-interactive';
import OurComponentsPage from './pages/05-our-components';
import UserStylesPage from './pages/06-user-styles';
import UserRenderPage from './pages/07-user-render';
import OverlayPage from './pages/02-overlay';
import CommentsPage from './pages/08-comments';
import RichPage from './pages/09-rich';
import { ThemeSwitcher } from '@/ui/theme-switcher';

// 开发者房间：控件在这里**逐件验证**；业务代码只允许使用登记过的控件。
const PAGES: Record<string, { title: string; el: () => React.ReactNode }> = {
  '01-interactive': { title: '01 · 交互与表单', el: () => <InteractivePage /> },
  '02-overlay': { title: '02 · 浮层与反馈', el: () => <OverlayPage /> },
  '05-our-components': { title: '05 · 我们的组合件', el: () => <OurComponentsPage /> },
  '06-user-styles': { title: '06 · 用户向风格候选', el: () => <UserStylesPage /> },
  '07-user-render': { title: '07 · 用户身份控件', el: () => <UserRenderPage /> },
  '08-comments': { title: '08 · 评论区', el: () => <CommentsPage /> },
  '09-rich': { title: '09 · 富文本与图片', el: () => <RichPage /> },
};

export function DevRoom({ page }: { page: string }) {
  const current = PAGES[page] ?? PAGES['01-interactive']!;
  return (
    <div className='min-h-screen bg-background text-foreground'>
      <header className='border-b border-border bg-background'>
        <div className='mx-auto flex max-w-[1100px] flex-col gap-2 px-5 py-4'>
          <h1 className='text-lg font-semibold'>开发者房间 · DevRoom</h1>
          <p className='text-[13px] leading-relaxed text-muted-foreground'>
            这里逐个验证控件。**业务代码只允许使用已登记（src/devroom/registry.ts）的控件**；
            需要新控件 → 先在本房间加一页验证 → 登记 → 才能用。未登记会被 pnpm gate:controls 挡住。
          </p>
          <nav aria-label='开发者房间页面' className='flex flex-wrap items-center gap-2 pt-1'>
            {Object.entries(PAGES).map(([key, p]) => (
              <Button key={key} href={appPath('?page=' + key)} active={key === page}>
                {p.title}
              </Button>
            ))}
            <span className='ml-auto flex items-center gap-3'>
              <span className='text-xs text-muted-foreground'>已登记控件：{VERIFIED.length} 个</span>
              <ThemeSwitcher />
            </span>
          </nav>
        </div>
      </header>
      <main className='mx-auto flex max-w-[1100px] flex-col gap-4 px-5 py-5'>{current.el()}</main>
    </div>
  );
}

